/**
 * Minimal OpenAI-compatible client for the loopback request
 * (Generator -> localhost LM Studio API -> loaded model).
 *
 * - streaming SSE + non-stream fallback
 * - optional absolute timeout (timeoutMs=0 disables it)
 * - external abort support (LM Studio cancellation / GUI Abort button)
 * - lightweight activity telemetry; reasoning text is never surfaced or logged,
 *   only the fact/size of reasoning activity is reported to the status UI
 * - loopback-only guard so screenshots cannot be sent to a remote API by typo
 */
import { dbg, err, info, warn } from "./log.js";
import { describeMessageShape, normalizeOpenAIMessages, normalizeToolCallAny } from "./messages.js";
import { BridgeError, type OpenAIToolCall, type OpenAIToolDef } from "./types.js";

export interface ChatRequest {
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: OpenAIToolDef[];
  [key: string]: unknown;
}

export interface ChatResult {
  content: string;
  toolCalls: OpenAIToolCall[];
  model: string | null;
  finishReason: string | null;
  viaStream: boolean;
}

export interface ChatStreamObserver {
  onRequestStart?: (info: { url: string; at: number }) => void;
  onConnected?: (info: { status: number; contentType: string; at: number }) => void;
  onNetworkActivity?: (info: { at: number; bytes?: number }) => void;
  onReasoningActivity?: (info: { at: number; chars: number }) => void;
  onContentActivity?: (info: { at: number; chars: number }) => void;
  onToolActivity?: (info: { at: number; fragments: number }) => void;
  onComplete?: (info: { at: number; finishReason: string | null }) => void;
}

interface StreamState {
  content: string;
  finishReason: string | null;
  model: string | null;
  firstTokenAt: number | null;
  acc: Map<number, { id: string; name: string; arguments: string }>;
  lmCalls: Array<Record<string, unknown>>;
}

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try { fn(); } catch { /* telemetry must never break generation */ }
}

function stringSize(v: unknown, depth = 0): number {
  if (typeof v === "string") return v.length;
  if (depth >= 2 || v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.reduce((n, x) => n + stringSize(x, depth + 1), 0);
  if (typeof v === "object") {
    let n = 0;
    for (const x of Object.values(v as Record<string, unknown>).slice(0, 20)) n += stringSize(x, depth + 1);
    return n;
  }
  return 0;
}

function reasoningChars(holder: Record<string, unknown>): number {
  // LM Studio/model backends have used a few different names. We intentionally
  // count activity only; the actual chain-of-thought text is not exposed.
  let n = 0;
  for (const key of ["reasoning_content", "reasoning", "reasoning_text", "analysis"]) {
    n += stringSize(holder[key]);
  }
  return n;
}

function handleChunk(
  json: unknown,
  state: StreamState,
  onDelta: (t: string) => void,
  observer?: ChatStreamObserver,
  isWhole = false
): void {
  if (!json || typeof json !== "object") return;
  const o = json as Record<string, unknown>;
  if (typeof o.model === "string") state.model = o.model;
  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0] as Record<string, unknown>;
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  const holder = (isWhole ? choice.message : choice.delta) as Record<string, unknown> | undefined;
  if (!holder || typeof holder !== "object") return;

  const rChars = reasoningChars(holder);
  if (rChars > 0) {
    safeCall(() => observer?.onReasoningActivity?.({ at: Date.now(), chars: rChars }));
  }

  const contentDelta = typeof holder.content === "string" ? holder.content : "";
  if (contentDelta.length > 0) {
    if (state.firstTokenAt === null) state.firstTokenAt = Date.now();
    state.content += contentDelta;
    safeCall(() => observer?.onContentActivity?.({ at: Date.now(), chars: contentDelta.length }));
    if (!isWhole) onDelta(contentDelta);
  }

  let toolFragments = 0;
  const tcd = holder.tool_calls;
  if (Array.isArray(tcd)) {
    for (const tc of tcd) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const idx = typeof t.index === "number" ? t.index : state.acc.size;
      const a = state.acc.get(idx) ?? { id: "", name: "", arguments: "" };
      if (typeof t.id === "string" && t.id) a.id = t.id;
      const fn = t.function as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn.name === "string") a.name += fn.name;
        if (typeof fn.arguments === "string") a.arguments += fn.arguments;
      }
      state.acc.set(idx, a);
      toolFragments += 1;
    }
  }

  const lm = holder.toolCallRequest ?? (holder.tool !== undefined ? { tool: holder.tool, args: holder.args } : undefined);
  if (lm && typeof lm === "object" && typeof (lm as Record<string, unknown>).tool === "string") {
    state.lmCalls.push(lm as Record<string, unknown>);
    toolFragments += 1;
  }
  if (toolFragments > 0) {
    safeCall(() => observer?.onToolActivity?.({ at: Date.now(), fragments: toolFragments }));
  }
}

function finishToolCalls(state: StreamState): OpenAIToolCall[] {
  const out: OpenAIToolCall[] = [];
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

function assertLoopbackApiRoot(apiRoot: string): void {
  let url: URL;
  try {
    url = new URL(apiRoot);
  } catch {
    throw new BridgeError("api_bad_root", `Invalid apiRoot: ${apiRoot}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) {
    throw new BridgeError(
      "api_non_loopback",
      `Vision Bridge refuses non-loopback apiRoot "${apiRoot}". This tool may send screenshot image data; use localhost/127.0.0.1/::1 only.`
    );
  }
}

function makeAbortController(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const ctl = new AbortController();
  let timeout = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onExternalAbort = (): void => {
    if (!ctl.signal.aborted) ctl.abort(externalSignal?.reason ?? new Error("request aborted"));
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timeout = true;
      if (!ctl.signal.aborted) ctl.abort(new Error(`absolute timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: ctl.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
    timedOut: () => timeout,
  };
}

function abortBridgeError(url: string, timedOut: boolean, detail: string): BridgeError {
  if (timedOut) {
    return new BridgeError(
      "api_timeout",
      `Loopback request to ${url} exceeded the configured absolute timeout (${detail}). Set timeoutMs=0 to disable it.`
    );
  }
  return new BridgeError("api_aborted", `Loopback request was aborted (${detail}).`);
}

export async function chatCompletionStream(
  cfg: { apiRoot: string; apiKey: string; timeoutMs: number },
  req: ChatRequest,
  onDelta: (text: string) => void,
  options: { signal?: AbortSignal; observer?: ChatStreamObserver } = {}
): Promise<ChatResult> {
  assertLoopbackApiRoot(cfg.apiRoot);
  const url = `${cfg.apiRoot.replace(/\/+$/, "")}/v1/chat/completions`;

  const incoming = Array.isArray(req.messages) ? (req.messages as unknown[]) : [];
  info("api", "outgoing message shapes (pre-send)", {
    count: incoming.length,
    messages: incoming.map((m, i) => describeMessageShape(m, i)),
  });

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
    messages: (req.messages as unknown[]).length,
    tools: req.tools?.length ?? 0,
    bodyBytes: body.length,
    timeoutMs: cfg.timeoutMs,
  });
  const startedAt = Date.now();
  safeCall(() => options.observer?.onRequestStart?.({ url, at: startedAt }));

  const abort = makeAbortController(cfg.timeoutMs, options.signal);
  let res: Response;
  try {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body,
        signal: abort.signal,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (abort.signal.aborted) throw abortBridgeError(url, abort.timedOut(), detail);
      err("api", "connection to LM Studio API failed", { url, error: detail });
      throw new BridgeError(
        "api_connect_failed",
        `Cannot connect to ${url} (${detail}). Check that LM Studio Local Server is enabled and apiRoot is correct.`
      );
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    dbg("api", "HTTP response received", { status: res.status, contentType, ms: Date.now() - startedAt });
    safeCall(() => options.observer?.onConnected?.({ status: res.status, contentType, at: Date.now() }));

    if (res.status === 202) {
      const text = await res.text().catch(() => "");
      err("api", "request was queued (HTTP 202) — model busy; loopback deadlock risk", { body: text.slice(0, 500) });
      throw new BridgeError(
        "api_queued",
        "LM Studio accepted the request as a background job (202). The nested loopback request may be queued behind the current prediction."
      );
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      err("api", "non-OK response from LM Studio API", { status: res.status, body: text.slice(0, 1500) });
      throw new BridgeError("api_error", `LM Studio API returned ${res.status}: ${text.slice(0, 400)}`);
    }

    const state: StreamState = {
      content: "",
      finishReason: null,
      model: null,
      firstTokenAt: null,
      acc: new Map(),
      lmCalls: [],
    };

    try {
      if (contentType.includes("text/event-stream")) {
        let buffer = "";
        const processLine = (line: string): void => {
          const l = line.replace(/\r$/, "");
          if (!l.startsWith("data:")) return;
          const payload = l.slice(5).trim();
          if (!payload || payload === "[DONE]") return;
          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            dbg("api", "unparseable SSE data line", payload.slice(0, 200));
            return;
          }
          handleChunk(json, state, onDelta, options.observer);
        };
        const stream = res.body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> };
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              safeCall(() => options.observer?.onNetworkActivity?.({ at: Date.now(), bytes: value.length }));
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
        safeCall(() => options.observer?.onNetworkActivity?.({ at: Date.now(), bytes: Buffer.byteLength(text) }));
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (e) {
          throw new BridgeError("api_bad_json", `non-stream response was not valid JSON: ${(e as Error).message}`);
        }
        handleChunk(json, state, onDelta, options.observer, true);
        if (state.content.length > 0) onDelta(state.content);
      }
    } catch (e) {
      if (abort.signal.aborted) {
        const detail = e instanceof Error ? e.message : String(e);
        throw abortBridgeError(url, abort.timedOut(), detail);
      }
      throw e;
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
    if (toolCalls.length > 0) info("api", "model requested tool call(s)", toolCalls.map((t) => t.function.name));
    safeCall(() => options.observer?.onComplete?.({ at: Date.now(), finishReason: state.finishReason }));

    return {
      content: state.content,
      toolCalls,
      model: state.model,
      finishReason: state.finishReason,
      viaStream: contentType.includes("text/event-stream"),
    };
  } finally {
    abort.cleanup();
  }
}
