/**
 * VisionBridgeGenerator — LM Studio Generator implementation (prebuilt mirror of src/generator.ts).
 *
 * Per inference round:
 *   1. receive the (possibly tool-result-updated) chat history
 *   2. run the Vision Bridge (Phase 2/3) on an INTERNAL COPY of it
 *   3. forward the copy + tool definitions to the local OpenAI-compatible API
 *   4. stream text deltas back to LM Studio
 *   5. if the model requested tool calls, report them to LM Studio via the
 *      controller (LM Studio executes the MCP tools; we never do) and stop
 *
 * NOTE on the base class: the old beta SDK (bare "lmstudio" package) used to
 * provide a Generator base class whose only role was holding the controller.
 * The current plugin host registers generator FUNCTIONS instead (see
 * src/index.ts), and "lmstudio" is not an installable host dependency any
 * more, so the class now extends a minimal local base. All behavior is unchanged.
 */
// (no bare "lmstudio" import — see note above)
import { loadConfig } from "./config.js";
import { configure as configureLog, dbg, err, info, warn } from "./log.js";
import { getControllerTools, getWorkingDirectory, getModelInfo, reportToolCall } from "./controller.js";
import { chatCompletionStream } from "./openai-client.js";
import { toOpenAITools } from "./messages.js";
import { applyVisionBridge } from "./vision-bridge.js";
import { SeenTracker } from "./dedup.js";

const SENTINEL_END = "__VB_END__";
const SENTINEL_ERR = "__VB_ERR__:";

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiter = null;
  }

  push(item) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else {
      this.items.push(item);
    }
  }

  pop() {
    if (this.items.length > 0) {
      const v = this.items.shift();
      return Promise.resolve(v);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

class GeneratorBase {
  constructor(ctl) {
    this.ctl = ctl;
  }
}
const BaseCtor = GeneratorBase;

export class VisionBridgeGenerator extends BaseCtor {
  constructor(ctl) {
    super(ctl);
    const ctlAny = ctl ?? {};
    const wd = getWorkingDirectory(ctlAny);
    this.cfg = loadConfig(wd);
    configureLog(this.cfg.logLevel, this.cfg.logFile);
    this.seen = new SeenTracker(wd);
    this.invocation = 0;
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

  async *generate(messages, ...rest) {
    this.invocation += 1;
    const inv = `inv${this.invocation}`;
    const msgArr = Array.isArray(messages) ? messages : [];
    info("gen", `invocation ${inv} started`, {
      messages: msgArr.length,
      roles: msgArr.map((m) => (m && typeof m === "object" ? m.role : "?")).join(" "),
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

    const req = { model: this.cfg.model, messages: bridge.messages, stream: true };
    if (tools && tools.length > 0) req.tools = tools;

    const queue = new AsyncQueue();
    const runPromise = chatCompletionStream(
      { apiRoot: this.cfg.apiRoot, apiKey: this.cfg.apiKey, timeoutMs: this.cfg.timeoutMs },
      req,
      (t) => queue.push(t)
    ).then(
      (result) => {
        queue.push(SENTINEL_END);
        return { ok: true, result };
      },
      (error) => {
        queue.push(SENTINEL_ERR + (error instanceof Error ? error.message : String(error)));
        return { ok: false, error };
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
            let args = {};
            try {
              const p = JSON.parse(tc.function.arguments || "{}");
              if (p && typeof p === "object" && !Array.isArray(p)) args = p;
            } catch (e) {
              warn("gen", "tool call arguments were not valid JSON", {
                raw: (tc.function.arguments ?? "").slice(0, 300),
                error: String(e),
              });
            }
            const lsCall = { id: tc.id, tool: tc.function.name, args };
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
