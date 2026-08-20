/**
 * Official LM Studio plugin entry point (prebuilt mirror of src/index.ts).
 *
 * The host's generated bootstrap (.lmstudio/entry.ts, produced by `lms dev`)
 * does exactly this:
 *
 *   import("./../src/index.ts").then(async module => module.main(pluginContext))
 *
 * so the TS source MUST live at src/index.ts and export an async `main()`.
 * (Same layout as the official lmstudio/openai-compat-endpoint and
 *  lmstudio/remote-lmstudio generator plugins.)
 *
 * The generator registered below reuses the existing, harness-tested
 * Vision Bridge pipeline verbatim (config / dedup / vision-bridge /
 * controller / messages / openai-client). Loopback design unchanged:
 *
 *   LM Studio Chat -> this generator -> localhost OpenAI-compatible API
 *   (default http://127.0.0.1:1238) -> the real model (Qwen3.8-27B)
 *
 * Tool calls are reported to LM Studio (which executes the MCP tools); we
 * never execute MCP tools ourselves.
 *
 * NOTE: no top-level await, no bare runtime imports other than node:
 * builtins (the host bundles with esbuild: CJS, --target=node18.16.0,
 * --packages=external). Structural types only — no @lmstudio/sdk import.
 *
 * THE SECOND ARGUMENT IS THE SDK `Chat` CLASS (not an array):
 *   Generator = (ctl: GeneratorController, history: Chat) => Promise
 * The adapter below (isSdkChat / sdkChatMessages / sdkChatToPlainMessages)
 * converts it to the plain shape the rest of the pipeline understands.
 */
import { loadConfig } from "./config.js";
import { configure as configureLog, dbg, err, info, warn } from "./log.js";
import { SeenTracker } from "./dedup.js";
import { applyVisionBridge } from "./vision-bridge.js";
import { chatCompletionStream } from "./openai-client.js";
import { toOpenAITools } from "./messages.js";
import { getControllerTools, getWorkingDirectory, reportToolCall } from "./controller.js";

/**
 * Report one model-side tool call to LM Studio via the CURRENT host API
 * (the same sequence the official remote-lmstudio plugin uses with
 * LMStudioClient callbacks):
 *
 *   started -> name -> argument fragment(s) -> ended({name, arguments})
 *
 * Returns true when the call was reported.
 */
function reportToolCallNewApi(ctl, tc) {
  const c = ctl;
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
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(argsJson || "{}");
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

// --- SDK `Chat` history adapter (current host API) --------------------------
//
// The current host calls the generator as:
//
//   export type Generator = (ctl: GeneratorController, history: Chat) => Promise;
//
// where `Chat` is the @lmstudio/sdk CLASS (NOT a plain array):
//
//   chat.getLength() / chat.getMessagesArray() / chat.at(i)
//   msg.getRole() / msg.getText()
//   msg.getToolCallRequests()   -> { id?, type:"function", name, arguments? }[]
//   msg.getToolCallResults()    -> { content, toolCallId?, name? }[]
//   msg.getFiles(client)        -> FileHandle[] (name, isImage(), getFilePath())
//
// We convert that into the SAME plain message shape the rest of the pipeline
// (messages.ts / vision-bridge.ts, harness-tested) already understands, so
// the bridge / dedup / synthetic-message logic stays untouched.

function callBound(obj, method, ...args) {
  if (!obj || typeof obj !== "object") return undefined;
  const fn = obj[method];
  if (typeof fn !== "function") return undefined;
  try {
    return fn.apply(obj, args);
  } catch {
    return undefined;
  }
}

/** Structural detection of the SDK Chat class instance (avoids importing the SDK). */
function isSdkChat(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (typeof v.getMessagesArray === "function") return true;
  return typeof v.at === "function" && typeof v.getLength === "function";
}

function sdkChatMessages(chat) {
  const fn = chat.getMessagesArray;
  if (typeof fn === "function") {
    try {
      const arr = fn.call(chat);
      if (Array.isArray(arr)) return arr;
    } catch {
      /* fall through to iteration */
    }
  }
  const it = chat[Symbol.iterator];
  if (typeof it === "function") {
    try {
      return Array.from(it.call(chat));
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
async function sdkChatToPlainMessages(chat, client) {
  const sdkMessages = sdkChatMessages(chat);
  const out = [];
  for (let i = 0; i < sdkMessages.length; i++) {
    const m = sdkMessages[i];
    const roleRaw = callBound(m, "getRole") ?? "user";
    const role = ["system", "user", "assistant", "tool"].includes(roleRaw) ? roleRaw : "user";
    const text = callBound(m, "getText") ?? "";
    const toolCallRequests = callBound(m, "getToolCallRequests") ?? [];
    const toolCallResults = callBound(m, "getToolCallResults") ?? [];
    const files = callBound(m, "getFiles", client) ?? [];

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
        toolCallResults.forEach((r, j) => {
          const rr = r ?? {};
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

    const msg = { role, content: text };

    if (role === "assistant" && toolCallRequests.length > 0) {
      msg.tool_calls = toolCallRequests.map((r, j) => {
        const rr = r ?? {};
        const name = (typeof rr.name === "string" && rr.name) || (typeof rr.tool === "string" && rr.tool) || "unknown";
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
      // later by messages.js::partImagePart); non-images stay visible as text.
      const parts = [];
      const extraTexts = [];
      for (const fh of files) {
        const f = fh ?? {};
        const name = (typeof f.name === "string" && f.name) || "file";
        const isImage = typeof f.isImage === "function" ? (callBound(f, "isImage") ?? true) : true;
        if (!isImage) {
          extraTexts.push(`[attached file: ${name}]`);
          continue;
        }
        let p;
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
 * Called by LM Studio for every prediction round with the (possibly
 * tool-result-updated) chat history. Text is streamed via
 * ctl.fragmentGenerated() — the streaming mechanism of the current host.
 */
export async function generate(ctl, chat) {
  const ctlAny = ctl ?? {};
  const wd = getWorkingDirectory(ctlAny) ?? null;
  const cfg = loadConfig(wd);
  configureLog(cfg.logLevel, cfg.logFile);
  const seen = new SeenTracker(wd);

  // --- Resolve the incoming history into plain messages ---------------------
  // Current host: `chat` is the @lmstudio/sdk Chat CLASS (Generator =
  // (ctl, history: Chat) => Promise) — NOT a plain array. Older/harness
  // shapes: a plain array or a {messages: [...]} wrapper. All shapes are
  // normalized to the plain format the rest of the pipeline understands.
  let messages;
  let historyShape;
  if (isSdkChat(chat)) {
    historyShape = "sdk-Chat";
    messages = await sdkChatToPlainMessages(chat, ctlAny.client);
  } else if (Array.isArray(chat)) {
    historyShape = "array";
    messages = chat;
  } else if (chat && typeof chat === "object" && Array.isArray(chat.messages)) {
    historyShape = "{messages:[...]}";
    messages = chat.messages;
  } else {
    historyShape = chat === null ? "null" : typeof chat;
    if (chat && typeof chat === "object") {
      warn("gen", "unrecognized chat shape; treating history as empty", {
        keys: Object.keys(chat).slice(0, 20),
      });
    }
    messages = [];
  }

  info("gen", "generate() invoked by LM Studio", {
    messages: messages.length,
    roles: messages.slice(0, 32).map((m) => (m && typeof m.role === "string" ? m.role : "?")).join(","),
    historyShape,
    workingDirectory: wd,
    apiRoot: cfg.apiRoot,
    model: cfg.model,
    seenImages: seen.size,
  });

  // --- Guard: truly empty history -> do NOT POST empty messages (API 400) ---
  if (messages.length === 0) {
    err("gen", "empty chat history received — refusing to POST empty messages (API would 400)", {
      historyShape,
    });
    if (typeof ctlAny.fragmentGenerated === "function") {
      try {
        ctlAny.fragmentGenerated(
          "⚠️ Vision Bridge: LM Studio passed an empty conversation history; nothing to generate. Send a message and try again."
        );
      } catch {
        /* host may already be gone */
      }
    }
    return;
  }

  // --- Phase 2/3 on an INTERNAL copy (never mutates the LM Studio history) ---
  const bridge = applyVisionBridge({ ctl: ctlAny, messages, cfg, seen });
  dbg("gen", "outgoing chat prepared", {
    outgoingMessages: bridge.messages.length,
    injectedImages: bridge.injected.map((i) => i.relativePath),
    skippedDuplicates: bridge.skippedDuplicates,
  });

  // --- tool definitions: probe the controller (covers getToolDefinitions) ---
  const tools = toOpenAITools(getControllerTools(ctlAny));
  if (tools) {
    dbg("gen", "forwarding tool definitions to model", {
      count: tools.length,
      names: tools.map((t) => t.function.name),
    });
  } else {
    warn("gen", "no tool definitions found on the controller — model cannot issue MCP tool calls this round");
  }

  const req = { model: cfg.model, messages: bridge.messages, stream: true };
  if (tools && tools.length > 0) req.tools = tools;

  // --- stream text deltas back to LM Studio ---
  const newCtl = ctlAny;
  const emit = (t) => {
    if (typeof newCtl.fragmentGenerated === "function") {
      try {
        newCtl.fragmentGenerated(t);
      } catch (e) {
        dbg("gen", "fragmentGenerated threw (host may have cancelled); continuing loopback drain", String(e));
      }
    }
  };

  let result;
  try {
    result = await chatCompletionStream(
      { apiRoot: cfg.apiRoot, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs },
      req,
      emit
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err("gen", "loopback request failed", msg);
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

  // --- tool calls: report to LM Studio (it executes the MCP tools) and stop ---
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

      const reportedNew = reportToolCallNewApi(ctlAny, tc);
      if (reportedNew) {
        info("gen", "stopping: LM Studio will execute the MCP tool(s) and call generate() again");
        continue;
      }

      // Legacy fallback (old beta host API: report_tool_call & co.)
      const reportedLegacy = reportToolCall(ctlAny, { id: tc.id, tool: tc.function.name, args });
      if (!reportedLegacy) {
        err("gen", "tool call could not be reported to LM Studio (no known API on the controller)");
        emit(
          `⚠️ Vision Bridge: tool call "${tc.function.name}" could not be forwarded to LM Studio ` +
            "(SDK adapter mismatch). Check the vision-bridge log."
        );
      }
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
export async function main(context) {
  const ctx = context;
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
