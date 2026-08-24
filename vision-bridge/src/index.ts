/**
 * Official LM Studio plugin entry point.
 *
 * The host's generated bootstrap (.lmstudio/entry.ts, produced by `lms dev`)
 * does exactly this:
 *
 *   import("./../src/index.ts").then(async module => module.main(pluginContext))
 *
 * so this file MUST live at src/index.ts and MUST export an async `main()`.
 * (Same layout as the official lmstudio/openai-compat-endpoint and
 *  lmstudio/remote-lmstudio generator plugins.)
 *
 * The generator registered below reuses the existing, harness-tested pipeline
 * verbatim:
 *
 *   - src/config.ts          (env / .vision-bridge/config.json settings)
 *   - src/dedup.ts           (SeenTracker content-hash dedup)
 *   - src/vision-bridge.ts   (Phase 3: synthetic image-message injection)
 *   - src/controller.ts      (SDK adapter: working dir, tools, legacy reporting)
 *   - src/messages.ts        (history -> OpenAI messages, tool defs)
 *   - src/openai-client.ts   (loopback POST /v1/chat/completions, SSE stream)
 *
 * Loopback design (unchanged):
 *   LM Studio Chat
 *     -> this generator (Vision Bridge)
 *     -> localhost LM Studio OpenAI-compatible API (default http://127.0.0.1:1238)
 *     -> the real model loaded in LM Studio (Qwen3.8-27B)
 *
 * Tool calls: the model's tool call is reported to LM Studio (which executes
 * the MCP tool) and then LM Studio calls generate() again with the updated
 * history. We never execute MCP tools ourselves.
 *
 * NOTE: no top-level await and no bare runtime imports other than node:
 * builtins — the host bundles this file with esbuild (CJS output,
 * --target=node18.16.0, --packages=external), so all of the following must
 * hold: no TLA, and every bare specifier must be resolvable in node_modules.
 * (This file therefore uses structural types instead of importing the
 * @lmstudio/sdk types at compile time.)
 */
import { loadConfig } from "./config.js";
import { configure as configureLog, dbg, err, info, warn } from "./log.js";
import { SeenTracker } from "./dedup.js";
import { applyVisionBridge } from "./vision-bridge.js";
import { chatCompletionStream, type ChatRequest, type ChatStreamObserver } from "./openai-client.js";
import { toOpenAITools } from "./messages.js";
import { getControllerTools, getWorkingDirectory, reportToolCall } from "./controller.js";
import type { AnyController, AnyMessage, OpenAIToolCall } from "./types.js";
import { beginRuntime, patchRuntime, startAbortWatcher, startRuntimeHeartbeat } from "./runtime-state.js";

/**
 * Permissive structural view of the current host GeneratorController
 * (@lmstudio/sdk). Every member is optional on purpose: if a method is
 * missing we fall back to the legacy reporting path (src/controller.ts),
 * so a host API drift degrades to a logged error instead of a crash.
 */
interface NewGeneratorController {
  fragmentGenerated?: (content: string, fragment?: unknown) => void;
  toolCallGenerationStarted?: () => void;
  toolCallGenerationNameReceived?: (name: string) => void;
  toolCallGenerationArgumentFragmentGenerated?: (content: string) => void;
  toolCallGenerationEnded?: (toolCallRequest: { type: string; id?: string; name: string; arguments: Record<string, unknown> }) => void;
  toolCallGenerationFailed?: (error: unknown) => void;
  [key: string]: unknown;
}

/**
 * Report one model-side tool call to LM Studio via the CURRENT host API
 * (the same sequence the official remote-lmstudio plugin uses with
 * LMStudioClient callbacks):
 *
 *   started -> name -> argument fragment(s) -> ended({name, arguments})
 *
 * Returns true when the call was reported.
 */
function reportToolCallNewApi(ctl: AnyController, tc: OpenAIToolCall): boolean {
  const c = ctl as NewGeneratorController;
  if (typeof c.toolCallGenerationStarted !== "function" || typeof c.toolCallGenerationEnded !== "function") {
    return false;
  }
  const argsJson = tc.function.arguments || "{}";
  try {
    c.toolCallGenerationStarted();
    if (typeof c.toolCallGenerationNameReceived === "function") c.toolCallGenerationNameReceived(tc.function.name);
    if (typeof c.toolCallGenerationArgumentFragmentGenerated === "function") {
      c.toolCallGenerationArgumentFragmentGenerated(argsJson);
    }
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(argsJson || "{}" ) as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }
    c.toolCallGenerationEnded({ type: "function", id: tc.id, name: tc.function.name, arguments: parsedArgs });
    info("gen", "tool call reported to LM Studio (new GeneratorController API)", {
      id: tc.id,
      tool: tc.function.name,
    });
    return true;
  } catch (e) {
    warn("gen", "new-API tool-call reporting threw; falling back to legacy probe", String(e));
    try {
      if (typeof c.toolCallGenerationFailed === "function") c.toolCallGenerationFailed(e);
    } catch {
      /* host may already be gone; nothing else to do */
    }
    return false;
  }
}

/**
 * --- SDK `Chat` history adapter (current host API) --------------------------
 *
 * The current host calls the generator as:
 *
 *   export type Generator = (ctl: GeneratorController, history: Chat) => Promise;
 *
 * where `Chat` is the @lmstudio/sdk CLASS (NOT a plain array):
 *
 *   chat.getLength() / chat.getMessagesArray() / chat.at(i)
 *   msg.getRole() / msg.getText()
 *   msg.getToolCallRequests()   -> { id?, type:"function", name, arguments? }[]
 *   msg.getToolCallResults()    -> { content, toolCallId?, name? }[]
 *   msg.getFiles(client)        -> FileHandle[] (name, isImage(), getFilePath())
 *
 * We convert that into the SAME plain message shape the rest of the pipeline
 * (src/messages.ts / src/vision-bridge.ts, harness-tested) already
 * understands, so the bridge / dedup / synthetic-message logic stays
 * untouched. Plain-array histories (test harness, older host shapes) keep
 * working through the other branches in generate().
 */
function callBound<T = unknown>(obj: unknown, method: string, ...args: unknown[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const fn = (obj as Record<string, unknown>)[method];
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as (...a: unknown[]) => T).apply(obj, args);
  } catch {
    return undefined;
  }
}

/** Structural detection of the SDK Chat class instance (avoids importing the SDK). */
function isSdkChat(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.getMessagesArray === "function") return true;
  return typeof o.at === "function" && typeof o.getLength === "function";
}

function sdkChatMessages(chat: unknown): unknown[] {
  const fn = (chat as Record<string, unknown>).getMessagesArray;
  if (typeof fn === "function") {
    try {
      const arr = fn.call(chat);
      if (Array.isArray(arr)) return arr;
    } catch {
      /* fall through to iteration */
    }
  }
  const it = (chat as unknown as { [Symbol.iterator]?: () => Iterator<unknown> })[Symbol.iterator];
  if (typeof it === "function") {
    try {
      const iterator = it.call(chat);
      const out: unknown[] = [];
      for (;;) {
        const next = iterator.next();
        if (next.done) break;
        out.push(next.value);
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  return [];
}

/**
 * Convert an SDK Chat instance into plain messages (harness shape).
 * One ChatMessage may expand to multiple plain messages (a tool message can
 * carry several toolCallResults, matching the OpenAI one-result-per-message
 * format).
 */
async function sdkChatToPlainMessages(chat: unknown, client: unknown): Promise<AnyMessage[]> {
  const sdkMessages = sdkChatMessages(chat);
  const out: AnyMessage[] = [];
  for (let i = 0; i < sdkMessages.length; i++) {
    const m = sdkMessages[i];
    const roleRaw = callBound<string>(m, "getRole") ?? "user";
    const role = (["system", "user", "assistant", "tool"] as const).includes(roleRaw as never)
      ? (roleRaw as "system" | "user" | "assistant" | "tool")
      : "user";
    const text = callBound<string>(m, "getText") ?? "";
    const toolCallRequests = callBound<unknown[]>(m, "getToolCallRequests") ?? [];
    const toolCallResults = callBound<unknown[]>(m, "getToolCallResults") ?? [];
    const files = callBound<unknown[]>(m, "getFiles", client) ?? [];

    info("gen", "history message (from SDK Chat)", {
      at: i,
      role,
      textChars: text.length,
      toolCallRequests: toolCallRequests.length,
      toolCallResults: toolCallResults.length,
      files: files.length,
    });

    if (role === "tool") {
      if (toolCallResults.length === 0) {
        // Defensive: a tool-role message without typed results — keep its text.
        out.push({ role: "tool", tool_call_id: `call_vb_t${i}`, content: text });
      } else {
        toolCallResults.forEach((r: unknown, j: number) => {
          const rr = (r ?? {}) as Record<string, unknown>;
          out.push({
            role: "tool",
            tool_call_id:
              (typeof rr.toolCallId === "string" && rr.toolCallId) ||
              `call_vb_t${i}${toolCallResults.length > 1 ? `_${j}` : ""}`,
            content: typeof rr.content === "string" ? rr.content : String(rr.content ?? ""),
          });
        });
      }
      continue;
    }

    const msg: AnyMessage = { role, content: text };

    if (role === "assistant" && toolCallRequests.length > 0) {
      msg.tool_calls = toolCallRequests.map((r: unknown, j: number) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        const name =
          (typeof rr.name === "string" && rr.name) || (typeof rr.tool === "string" && rr.tool) || "unknown";
        const args = rr.arguments ?? rr.args ?? {};
        return {
          id: (typeof rr.id === "string" && rr.id) || `call_vb_a${i}_${j}`,
          type: "function",
          function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        };
      });
    }

    if ((role === "user" || role === "system") && files.length > 0) {
      // Attached files: images become file parts (materialized to data URLs
      // later by messages.ts::partImagePart); non-images stay visible as text.
      const parts: unknown[] = [];
      const extraTexts: string[] = [];
      for (const fh of files) {
        const f = (fh ?? {}) as Record<string, unknown>;
        const name = (typeof f.name === "string" && f.name) || "file";
        const isImage = typeof f.isImage === "function" ? (callBound<boolean>(f, "isImage") ?? true) : true;
        if (!isImage) {
          extraTexts.push(`[attached file: ${name}]`);
          continue;
        }
        let p: unknown;
        if (typeof f.getFilePath === "function") {
          try {
            p = await Promise.resolve(f.getFilePath.call(f));
          } catch {
            p = undefined; // e.g. base64-backed files throw — degrade to name
          }
        }
        if (typeof p === "string" && p.length > 0) {
          parts.push({ type: "file", name, path: p });
        } else {
          extraTexts.push(`[attached file: ${name}]`);
        }
      }
      const joined =
        extraTexts.length > 0 ? (text.length > 0 ? `${text}\n${extraTexts.join("\n")}` : extraTexts.join("\n")) : text;
      if (parts.length > 0) {
        msg.content = joined.length > 0 ? [{ type: "text", text: joined }, ...parts] : parts;
      } else {
        msg.content = joined;
      }
    }

    out.push(msg);
  }
  return out;
}

/**
 * Generator function registered with the host (`context.withGenerator`).
 *
 * Called by LM Studio for every prediction round with the (possibly
 * tool-result-updated) chat history. Yields text via
 * ctl.fragmentGenerated() — the streaming mechanism of the current host
 * (the old "yield strings" beta API is not used by the current host).
 */
export async function generate(ctl: unknown, chat: unknown): Promise<void> {
  const ctlAny = (ctl ?? {}) as AnyController;
  const wd = getWorkingDirectory(ctlAny) ?? null;
  const cfg = loadConfig(wd);
  configureLog(cfg.logLevel, cfg.logFile);
  const seen = new SeenTracker(wd);

  // --- Resolve the incoming history into plain messages ---------------------
  let messages: AnyMessage[];
  let historyShape: string;
  if (isSdkChat(chat)) {
    historyShape = "sdk-Chat";
    messages = await sdkChatToPlainMessages(chat, (ctlAny as Record<string, unknown>).client);
  } else if (Array.isArray(chat)) {
    historyShape = "array";
    messages = chat as AnyMessage[];
  } else if (chat && typeof chat === "object" && Array.isArray((chat as { messages?: unknown }).messages)) {
    historyShape = "{messages:[...]}";
    messages = (chat as { messages: AnyMessage[] }).messages;
  } else {
    historyShape = chat === null ? "null" : typeof chat;
    if (chat && typeof chat === "object") {
      warn("gen", "unrecognized chat shape; treating history as empty", { keys: Object.keys(chat).slice(0, 20) });
    }
    messages = [];
  }

  const invocationId = `vb-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  beginRuntime({
    invocationId,
    phase: "preparing",
    startedAt: Date.now(),
    model: cfg.model,
    apiRoot: cfg.apiRoot,
    timeoutMs: cfg.timeoutMs,
    workingDirectory: wd,
    logFile: cfg.logFile,
    messageCount: messages.length,
    toolCount: 0,
    injectedImages: [],
    skippedImages: 0,
    note: "Preparing outgoing history.",
  });
  const stopHeartbeat = startRuntimeHeartbeat(invocationId);

  // One controller links three cancellation sources: GUI Abort, LM Studio's
  // own abort signal (when exposed), and the optional absolute timeout inside
  // openai-client.ts.
  const requestAbort = new AbortController();
  const hostSignal = (ctlAny as Record<string, unknown>).abortSignal;
  const onHostAbort = (): void => {
    if (!requestAbort.signal.aborted) requestAbort.abort(new Error("LM Studio aborted the prediction"));
  };
  if (hostSignal && typeof hostSignal === "object" && "aborted" in hostSignal && "addEventListener" in hostSignal) {
    const hs = hostSignal as AbortSignal;
    if (hs.aborted) onHostAbort();
    else hs.addEventListener("abort", onHostAbort, { once: true });
  }
  const stopAbortWatcher = startAbortWatcher(invocationId, () => {
    patchRuntime(invocationId, { note: "Abort requested from Vision Bridge GUI." });
    if (!requestAbort.signal.aborted) requestAbort.abort(new Error("aborted from Vision Bridge GUI"));
  });

  info("gen", "generate() invoked by LM Studio", {
    invocationId,
    messages: messages.length,
    roles: messages.slice(0, 32).map((m) => (m && typeof m.role === "string" ? m.role : "?")).join(","),
    historyShape,
    workingDirectory: wd,
    apiRoot: cfg.apiRoot,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    seenImages: seen.size,
  });

  try {
    if (messages.length === 0) {
      err("gen", "empty chat history received — refusing to POST empty messages (API would 400)", { historyShape });
      patchRuntime(invocationId, { phase: "error", error: "LM Studio passed an empty conversation history." });
      const newCtl = ctlAny as NewGeneratorController;
      if (typeof newCtl.fragmentGenerated === "function") {
        try {
          newCtl.fragmentGenerated(
            "⚠️ Vision Bridge: LM Studio passed an empty conversation history; nothing to generate. Send a message and try again."
          );
        } catch { /* host may already be gone */ }
      }
      return;
    }

    // --- Phase 2/3 on an INTERNAL copy (never mutates LM Studio history) -----
    const bridge = applyVisionBridge({ ctl: ctlAny, messages, cfg, seen });
    patchRuntime(invocationId, {
      injectedImages: bridge.injected.map((i) => i.relativePath),
      skippedImages: bridge.skippedDuplicates,
      note: bridge.injected.length > 0
        ? `Injected ${bridge.injected.length} image(s) into the outgoing vision request.`
        : "No new MCP image needed for this round.",
    });
    dbg("gen", "outgoing chat prepared", {
      outgoingMessages: bridge.messages.length,
      injectedImages: bridge.injected.map((i) => i.relativePath),
      skippedDuplicates: bridge.skippedDuplicates,
    });

    // --- tool definitions: probe the controller -----------------------------
    const tools = toOpenAITools(getControllerTools(ctlAny));
    patchRuntime(invocationId, { toolCount: tools?.length ?? 0 });
    if (tools) {
      dbg("gen", "forwarding tool definitions to model", { count: tools.length, names: tools.map((t) => t.function.name) });
    } else {
      warn("gen", "no tool definitions found on the controller — model cannot issue MCP tool calls this round");
    }

    const req: ChatRequest = { model: cfg.model, messages: bridge.messages, stream: true };
    if (tools && tools.length > 0) req.tools = tools;

    // --- stream text deltas back to LM Studio -------------------------------
    const newCtl = ctlAny as NewGeneratorController;
    const emit = (t: string): void => {
      if (typeof newCtl.fragmentGenerated === "function") {
        try { newCtl.fragmentGenerated(t); }
        catch (e) { dbg("gen", "fragmentGenerated threw (host may have cancelled); continuing loopback drain", String(e)); }
      }
    };

    let textChars = 0;
    let reasoningChars = 0;
    let reasoningEvents = 0;
    let toolEvents = 0;
    const observer: ChatStreamObserver = {
      onRequestStart: ({ at }) => patchRuntime(invocationId, {
        phase: "connecting", requestStartedAt: at, note: "Opening LM Studio loopback request…",
      }),
      onConnected: ({ at, status }) => patchRuntime(invocationId, {
        phase: "connected", connectedAt: at, lastNetworkActivityAt: at,
        note: `HTTP ${status} connected. Waiting for model stream activity.`,
      }),
      onNetworkActivity: ({ at }) => patchRuntime(invocationId, { lastNetworkActivityAt: at }),
      onReasoningActivity: ({ at, chars }) => {
        reasoningChars += chars; reasoningEvents += 1;
        patchRuntime(invocationId, {
          phase: "reasoning", lastModelActivityAt: at, reasoningChars, reasoningEvents,
          note: "Reasoning stream activity detected (text intentionally hidden).",
        });
      },
      onContentActivity: ({ at, chars }) => {
        textChars += chars;
        patchRuntime(invocationId, { phase: "generating", lastModelActivityAt: at, textChars, note: "Answer text is streaming." });
      },
      onToolActivity: ({ at, fragments }) => {
        toolEvents += fragments;
        patchRuntime(invocationId, { phase: "tool_call", lastModelActivityAt: at, toolEvents, note: "Model is generating a tool call." });
      },
      onComplete: ({ finishReason }) => patchRuntime(invocationId, { finishReason }),
    };

    let result: Awaited<ReturnType<typeof chatCompletionStream>>;
    try {
      result = await chatCompletionStream(
        { apiRoot: cfg.apiRoot, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs },
        req,
        emit,
        { signal: requestAbort.signal, observer }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code ?? "") : "";
      const aborted = code === "api_aborted" || requestAbort.signal.aborted;
      err("gen", "loopback request failed", { code, message: msg });
      patchRuntime(invocationId, { phase: aborted ? "aborted" : "error", error: msg, note: aborted ? "Request stopped." : "Loopback request failed." });
      emit(`⚠️ Vision Bridge: ${msg}`);
      return;
    }

    info("gen", "model output received", {
      contentChars: result.content.length,
      toolCalls: result.toolCalls.length,
      model: result.model,
      finishReason: result.finishReason,
      viaStream: result.viaStream,
    });

    // --- tool calls: report to LM Studio (it executes MCP) and stop ----------
    if (result.toolCalls.length > 0) {
      patchRuntime(invocationId, { phase: "tool_call", note: `Forwarding ${result.toolCalls.length} tool call(s) to LM Studio.` });
      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const p = JSON.parse(tc.function.arguments || "{}") as unknown;
          if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
        } catch (e) {
          warn("gen", "tool call arguments were not valid JSON", { raw: (tc.function.arguments ?? "").slice(0, 300), error: String(e) });
        }

        const reportedNew = reportToolCallNewApi(ctlAny, tc);
        if (reportedNew) {
          info("gen", "LM Studio will execute the MCP tool(s) and call generate() again");
          continue;
        }

        const reportedLegacy = reportToolCall(ctlAny, { id: tc.id, tool: tc.function.name, args });
        if (!reportedLegacy) {
          err("gen", "tool call could not be reported to LM Studio (no known API on the controller)");
          patchRuntime(invocationId, { phase: "error", error: `Tool call "${tc.function.name}" could not be forwarded to LM Studio.` });
          emit(
            `⚠️ Vision Bridge: tool call "${tc.function.name}" could not be forwarded to LM Studio ` +
              "(SDK adapter mismatch). Check the vision-bridge log."
          );
          return;
        }
      }
      patchRuntime(invocationId, {
        phase: "completed", finishReason: result.finishReason,
        note: "Tool call forwarded. Waiting for LM Studio to execute MCP and start the next round.",
      });
      return;
    }

    patchRuntime(invocationId, {
      phase: "completed", finishReason: result.finishReason,
      note: "Model response completed normally.",
    });
  } finally {
    stopAbortWatcher();
    stopHeartbeat();
    if (hostSignal && typeof hostSignal === "object" && "removeEventListener" in hostSignal) {
      try { (hostSignal as AbortSignal).removeEventListener("abort", onHostAbort); } catch { /* ignore */ }
    }
  }
}

/**
 * Plugin entry point called by the host:
 *   import("./../src/index.ts").then(m => m.main(pluginContext))
 *
 * `withGenerator` is the current host API (same as the official
 * openai-compat-endpoint / remote-lmstudio plugins).
 */
export async function main(context: unknown): Promise<void> {
  const ctx = context as { withGenerator?: (generator: (ctl: unknown, chat: unknown) => Promise<void>) => unknown } | null;
  if (ctx && typeof ctx.withGenerator === "function") {
    ctx.withGenerator(generate);
    info("plugin", "Vision Bridge generator registered with LM Studio");
    return;
  }
  throw new Error(
    "PluginContext.withGenerator is not available — this LM Studio version's plugin host is incompatible. " +
      "Seen keys: " +
      (ctx ? Object.keys(ctx).slice(0, 30).join(", ") : "(no context)")
  );
}
