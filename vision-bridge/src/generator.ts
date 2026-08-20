/**
 * VisionBridgeGenerator — LM Studio Generator implementation.
 *
 * Per inference round:
 *   1. receive the (possibly tool-result-updated) chat history
 *   2. run the Vision Bridge (Phase 2/3) on an INTERNAL COPY of it
 *   3. forward the copy + tool definitions to the local OpenAI-compatible
 *      API (loopback) where the real model (Qwen3.8-27B) runs
 *   4. stream text deltas back to LM Studio
 *   5. if the model requested tool calls, report them to LM Studio via the
 *      controller (LM Studio executes the MCP tools; we never do) and stop —
 *      LM Studio will call generate() again with the updated history
 *
 * NOTE on the base class: the old beta SDK (bare "lmstudio" package) used to
 * provide a Generator base class whose only role was holding the controller.
 * The current plugin host registers generator FUNCTIONS instead (see
 * src/index.ts), and "lmstudio" is not an installable host dependency any
 * more, so the class now extends a minimal local base. All behavior —
 * generate(), tool-call reporting, loopback streaming — is unchanged.
 */
import { loadConfig, type Config } from "./config.js";
import { configure as configureLog, dbg, err, info, warn } from "./log.js";
import { getControllerTools, getWorkingDirectory, getModelInfo, reportToolCall } from "./controller.js";
import { chatCompletionStream, type ChatRequest } from "./openai-client.js";
import { toOpenAITools } from "./messages.js";
import { applyVisionBridge } from "./vision-bridge.js";
import { SeenTracker } from "./dedup.js";
import type { AnyController, AnyMessage, LsToolCall } from "./types.js";

const SENTINEL_END = "__VB_END__";
const SENTINEL_ERR = "__VB_ERR__:";

/** Tiny promise-backed queue so HTTP deltas can be yielded as they arrive. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiter: ((v: T) => void) | null = null;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else {
      this.items.push(item);
    }
  }

  pop(): Promise<T> {
    if (this.items.length > 0) {
      const v = this.items.shift() as T;
      return Promise.resolve(v);
    }
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }
}

class GeneratorBase {
  ctl: unknown;
  constructor(ctl: unknown) {
    this.ctl = ctl;
  }
}
const BaseCtor = GeneratorBase as new (ctl: AnyController) => {
  ctl: AnyController;
};

export class VisionBridgeGenerator extends BaseCtor {
  declare ctl: AnyController;
  private cfg: Config;
  private seen: SeenTracker;
  private invocation = 0;

  constructor(ctl: unknown) {
    super(ctl as AnyController);
    const ctlAny = (ctl ?? {}) as AnyController;
    const wd = getWorkingDirectory(ctlAny);
    this.cfg = loadConfig(wd);
    configureLog(this.cfg.logLevel, this.cfg.logFile);
    this.seen = new SeenTracker(wd);
    info("gen", "VisionBridge generator initialized", {
      apiRoot: this.cfg.apiRoot,
      model: this.cfg.model,
      workingDirectory: wd,
      bridgeEnabled: this.cfg.bridgeEnabled,
      logFile: this.cfg.logFile,
      seenImages: this.seen.size,
    });
    const mi = getModelInfo(ctlAny);
    if (mi) dbg("gen", "controller model info", { id: mi.id, name: mi.name });
  }

  async *generate(messages: unknown, ...rest: unknown[]): AsyncGenerator<string, void, unknown> {
    this.invocation += 1;
    const inv = `inv${this.invocation}`;
    const msgArr: AnyMessage[] = Array.isArray(messages) ? (messages as AnyMessage[]) : [];
    info("gen", `invocation ${inv} started`, {
      messages: msgArr.length,
      roles: msgArr.map((m) => (m && typeof m === "object" ? (m as AnyMessage).role : "?")).join(" "),
    });

    // --- Phase 2/3 on an internal copy (never mutates the input) ---
    const bridge = applyVisionBridge({ ctl: this.ctl, messages: msgArr, cfg: this.cfg, seen: this.seen });
    dbg("gen", "outgoing chat prepared", {
      outgoingMessages: bridge.messages.length,
      injectedImages: bridge.injected.map((i) => i.relativePath),
      skippedDuplicates: bridge.skippedDuplicates,
      workingDirectory: bridge.workingDirectory,
    });

    // --- tool definitions: generate() extra arg first, then controller ---
    const toolsArg = rest.find((r) => Array.isArray(r));
    const tools = toOpenAITools(toolsArg ?? getControllerTools(this.ctl));
    if (tools) {
      dbg("gen", "forwarding tool definitions to model", {
        count: tools.length,
        names: tools.map((t) => t.function.name),
      });
    } else {
      warn("gen", "no tool definitions found (not in generate() args nor on controller) — model cannot issue MCP tool calls this round");
    }

    const req: ChatRequest = { model: this.cfg.model, messages: bridge.messages, stream: true };
    if (tools && tools.length > 0) req.tools = tools;

    const queue = new AsyncQueue<string>();
    const runPromise = chatCompletionStream(
      { apiRoot: this.cfg.apiRoot, apiKey: this.cfg.apiKey, timeoutMs: this.cfg.timeoutMs },
      req,
      (t) => queue.push(t)
    ).then(
      (result) => {
        queue.push(SENTINEL_END);
        return { ok: true as const, result };
      },
      (error) => {
        queue.push(SENTINEL_ERR + (error instanceof Error ? error.message : String(error)));
        return { ok: false as const, error };
      }
    );

    for (;;) {
      const item = await queue.pop();

      if (item === SENTINEL_END) {
        const done = await runPromise;
        if (!done.ok) {
          err("gen", `${inv} finished with error`, String(done.error));
          return;
        }
        const result = done.result;
        info("gen", `${inv} model output received`, {
          contentChars: result.content.length,
          toolCalls: result.toolCalls.length,
          model: result.model,
          finishReason: result.finishReason,
          viaStream: result.viaStream,
        });

        if (result.toolCalls.length > 0) {
          for (const tc of result.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              const p = JSON.parse(tc.function.arguments || "{}") as unknown;
              if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
            } catch (e) {
              warn("gen", "tool call arguments were not valid JSON", {
                raw: (tc.function.arguments ?? "").slice(0, 300),
                error: String(e),
              });
            }
            const lsCall: LsToolCall = { id: tc.id, tool: tc.function.name, args };
            info("gen", "model requested a tool call — reporting to LM Studio (execution stays with LM Studio)", {
              id: lsCall.id,
              tool: lsCall.tool,
              argKeys: Object.keys(args),
            });
            if (!reportToolCall(this.ctl, lsCall)) {
              err("gen", "tool call could not be reported to LM Studio — the MCP loop cannot continue; see log for the controller surface");
              yield `⚠️ Vision Bridge: tool call "${lsCall.tool}" could not be forwarded to LM Studio (SDK adapter mismatch). Check the vision-bridge log.`;
            }
          }
          // After reporting, stop: LM Studio executes the MCP tool(s) and
          // calls generate() again with the updated history.
        }
        return;
      }

      if (item.startsWith(SENTINEL_ERR)) {
        const msg = item.slice(SENTINEL_ERR.length);
        err("gen", `${inv} failed`, msg);
        yield `⚠️ Vision Bridge: ${msg}`;
        return;
      }

      yield item;
    }
  }
}
