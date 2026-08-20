/**
 * Minimal OpenAI-compatible client for the loopback request (prebuilt mirror of src/openai-client.ts).
 */
import { dbg, err, info, warn } from "./log.js";
import { describeMessageShape, normalizeOpenAIMessages, normalizeToolCallAny } from "./messages.js";
import { BridgeError } from "./types.js";

function handleChunk(json, state, onDelta, isWhole = false) {
  if (!json || typeof json !== "object") return;
  const o = json;
  if (typeof o.model === "string") state.model = o.model;
  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0];
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  const holder = isWhole ? choice.message : choice.delta;
  if (!holder || typeof holder !== "object") return;

  if (typeof holder.content === "string" && holder.content.length > 0) {
    if (state.firstTokenAt === null) state.firstTokenAt = Date.now();
    state.content += holder.content;
    if (!isWhole) onDelta(holder.content);
  }

  const tcd = holder.tool_calls;
  if (Array.isArray(tcd)) {
    for (const tc of tcd) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc;
      const idx = typeof t.index === "number" ? t.index : state.acc.size;
      const a = state.acc.get(idx) ?? { id: "", name: "", arguments: "" };
      if (typeof t.id === "string" && t.id) a.id = t.id;
      const fn = t.function;
      if (fn) {
        if (typeof fn.name === "string") a.name += fn.name;
        if (typeof fn.arguments === "string") a.arguments += fn.arguments;
      }
      state.acc.set(idx, a);
    }
  }

  const lm = holder.toolCallRequest ?? (holder.tool !== undefined ? { tool: holder.tool, args: holder.args } : undefined);
  if (lm && typeof lm === "object" && typeof lm.tool === "string") {
    state.lmCalls.push(lm);
  }
}

function finishToolCalls(state) {
  const out = [];
  for (const [idx, a] of state.acc) {
    if (!a.name) continue;
    out.push({
      id: a.id || `call_vb_${idx}`,
      type: "function",
      function: { name: a.name, arguments: a.arguments || "{}" },
    });
  }
  for (let i = 0; i < state.lmCalls.length; i++) {
    const n = normalizeToolCallAny(state.lmCalls[i], i + out.length);
    if (n) out.push(n);
  }
  return out;
}

export async function chatCompletionStream(cfg, req, onDelta) {
  const url = `${cfg.apiRoot.replace(/\/+$/, "")}/v1/chat/completions`;

  // --- Pre-send diagnostic: exact content shape of every outgoing message --
  // (base64 bodies redacted by the logger). Pinpoints which message carries
  // content as object/null — the signature behind LM Studio's
  // "messages ... must contain a 'content' field. Got 'object'" 400.
  const incoming = Array.isArray(req.messages) ? req.messages : [];
  info("api", "outgoing message shapes (pre-send)", {
    count: incoming.length,
    messages: incoming.map((m, i) => describeMessageShape(m, i)),
  });

  // --- Enforce the official OpenAI message types (never null / raw object) -
  const normalized = normalizeOpenAIMessages(incoming);
  if (normalized.length !== incoming.length) {
    warn("api", "message count changed during normalization (invalid entries dropped)", {
      before: incoming.length,
      after: normalized.length,
    });
  }
  req = { ...req, messages: normalized };

  const body = JSON.stringify(req);
  info("api", "POST /v1/chat/completions (loopback)", {
    url,
    model: req.model,
    messages: req.messages.length,
    tools: req.tools?.length ?? 0,
    bodyBytes: body.length,
  });
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || /timeout/i.test(detail));
    err("api", "connection to LM Studio API failed", { url, error: detail, timedOut });
    throw new BridgeError(
      timedOut ? "api_timeout" : "api_connect_failed",
      `Cannot complete the loopback request to ${url} (${detail}). ` +
        (timedOut
          ? "The request hung — known loopback risk (LM Studio may queue the nested request behind the current one). See TESTING.md §Fallback."
          : "Check that LM Studio is running with its local server enabled and apiRoot is correct.")
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  dbg("api", "HTTP response received", { status: res.status, contentType, ms: Date.now() - startedAt });

  if (res.status === 202) {
    const text = await res.text().catch(() => "");
    err("api", "request was queued (HTTP 202) — model busy; loopback deadlock risk", { body: text.slice(0, 500) });
    throw new BridgeError(
      "api_queued",
      "LM Studio accepted the request as a background job (202). While the current turn holds the model this deadlocks — enable the fallback path (TESTING.md §Fallback)."
    );
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    err("api", "non-OK response from LM Studio API", { status: res.status, body: text.slice(0, 1500) });
    throw new BridgeError("api_error", `LM Studio API returned ${res.status}: ${text.slice(0, 400)}`);
  }

  const state = {
    content: "",
    finishReason: null,
    model: null,
    firstTokenAt: null,
    acc: new Map(),
    lmCalls: [],
  };

  if (contentType.includes("text/event-stream")) {
    let buffer = "";
    const processLine = (line) => {
      const l = line.replace(/\r$/, "");
      if (!l.startsWith("data:")) return;
      const payload = l.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        dbg("api", "unparseable SSE data line", payload.slice(0, 200));
        return;
      }
      handleChunk(json, state, onDelta);
    };
    const stream = res.body;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          buffer += Buffer.from(value).toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    if (buffer.trim().length > 0) processLine(buffer);
  } else {
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new BridgeError("api_bad_json", `non-stream response was not valid JSON: ${e.message}`);
    }
    handleChunk(json, state, onDelta, true);
    if (state.content.length > 0) onDelta(state.content);
  }

  const toolCalls = finishToolCalls(state);
  info("api", "loopback request complete", {
    viaStream: contentType.includes("text/event-stream"),
    contentChars: state.content.length,
    toolCalls: toolCalls.length,
    model: state.model,
    finishReason: state.finishReason,
    firstTokenMs: state.firstTokenAt === null ? null : state.firstTokenAt - startedAt,
    totalMs: Date.now() - startedAt,
  });
  if (toolCalls.length > 0) {
    info("api", "model requested tool call(s)", toolCalls.map((t) => t.function.name));
  }

  return {
    content: state.content,
    toolCalls,
    model: state.model,
    finishReason: state.finishReason,
    viaStream: contentType.includes("text/event-stream"),
  };
}
