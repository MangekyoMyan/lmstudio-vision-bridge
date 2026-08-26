"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openAiEndpoint = openAiEndpoint;
exports.chatCompletionStream = chatCompletionStream;
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
const log_js_1 = require("./log.js");
const messages_js_1 = require("./messages.js");
const types_js_1 = require("./types.js");
function openAiEndpoint(apiRoot, route) {
    const base = apiRoot.replace(/\/+$/, "");
    const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
    return /\/v1$/i.test(base) ? `${base}${normalizedRoute}` : `${base}/v1${normalizedRoute}`;
}
function safeCall(fn) {
    if (!fn)
        return;
    try {
        fn();
    }
    catch { /* telemetry must never break generation */ }
}
function stringSize(v, depth = 0) {
    if (typeof v === "string")
        return v.length;
    if (depth >= 2 || v === null || v === undefined)
        return 0;
    if (Array.isArray(v))
        return v.reduce((n, x) => n + stringSize(x, depth + 1), 0);
    if (typeof v === "object") {
        let n = 0;
        for (const x of Object.values(v).slice(0, 20))
            n += stringSize(x, depth + 1);
        return n;
    }
    return 0;
}
function reasoningChars(holder) {
    // LM Studio/model backends have used a few different names. We intentionally
    // count activity only; the actual chain-of-thought text is not exposed.
    let n = 0;
    for (const key of ["reasoning_content", "reasoning", "reasoning_text", "analysis"]) {
        n += stringSize(holder[key]);
    }
    return n;
}
function handleChunk(json, state, onDelta, observer, isWhole = false) {
    if (!json || typeof json !== "object")
        return;
    const o = json;
    if (typeof o.model === "string")
        state.model = o.model;
    const choices = o.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return;
    const choice = choices[0];
    if (typeof choice.finish_reason === "string")
        state.finishReason = choice.finish_reason;
    const holder = (isWhole ? choice.message : choice.delta);
    if (!holder || typeof holder !== "object")
        return;
    const rChars = reasoningChars(holder);
    if (rChars > 0) {
        safeCall(() => observer?.onReasoningActivity?.({ at: Date.now(), chars: rChars }));
    }
    const contentDelta = typeof holder.content === "string" ? holder.content : "";
    if (contentDelta.length > 0) {
        if (state.firstTokenAt === null)
            state.firstTokenAt = Date.now();
        state.content += contentDelta;
        safeCall(() => observer?.onContentActivity?.({ at: Date.now(), chars: contentDelta.length }));
        if (!isWhole)
            onDelta(contentDelta);
    }
    let toolFragments = 0;
    const tcd = holder.tool_calls;
    if (Array.isArray(tcd)) {
        for (const tc of tcd) {
            if (!tc || typeof tc !== "object")
                continue;
            const t = tc;
            const idx = typeof t.index === "number" ? t.index : state.acc.size;
            const a = state.acc.get(idx) ?? { id: "", name: "", arguments: "" };
            if (typeof t.id === "string" && t.id)
                a.id = t.id;
            const fn = t.function;
            if (fn) {
                if (typeof fn.name === "string")
                    a.name += fn.name;
                if (typeof fn.arguments === "string")
                    a.arguments += fn.arguments;
            }
            state.acc.set(idx, a);
            toolFragments += 1;
        }
    }
    const lm = holder.toolCallRequest ?? (holder.tool !== undefined ? { tool: holder.tool, args: holder.args } : undefined);
    if (lm && typeof lm === "object" && typeof lm.tool === "string") {
        state.lmCalls.push(lm);
        toolFragments += 1;
    }
    if (toolFragments > 0) {
        safeCall(() => observer?.onToolActivity?.({ at: Date.now(), fragments: toolFragments }));
    }
}
function finishToolCalls(state) {
    const out = [];
    for (const [idx, a] of state.acc) {
        if (!a.name)
            continue;
        out.push({
            id: a.id || `call_vb_${idx}`,
            type: "function",
            function: { name: a.name, arguments: a.arguments || "{}" },
        });
    }
    for (let i = 0; i < state.lmCalls.length; i++) {
        const n = (0, messages_js_1.normalizeToolCallAny)(state.lmCalls[i], i + out.length);
        if (n)
            out.push(n);
    }
    return out;
}
function assertLoopbackApiRoot(apiRoot) {
    let url;
    try {
        url = new URL(apiRoot);
    }
    catch {
        throw new types_js_1.BridgeError("api_bad_root", `Invalid apiRoot: ${apiRoot}`);
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (!loopback) {
        throw new types_js_1.BridgeError("api_non_loopback", `Vision Bridge refuses non-loopback apiRoot "${apiRoot}". This tool may send screenshot image data; use localhost/127.0.0.1/::1 only.`);
    }
}
function makeAbortController(timeoutMs, externalSignal) {
    const ctl = new AbortController();
    let timeout = false;
    let timer = null;
    const onExternalAbort = () => {
        if (!ctl.signal.aborted)
            ctl.abort(externalSignal?.reason ?? new Error("request aborted"));
    };
    if (externalSignal) {
        if (externalSignal.aborted)
            onExternalAbort();
        else
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            timeout = true;
            if (!ctl.signal.aborted)
                ctl.abort(new Error(`absolute timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
    }
    return {
        signal: ctl.signal,
        cleanup: () => {
            if (timer)
                clearTimeout(timer);
            externalSignal?.removeEventListener("abort", onExternalAbort);
        },
        timedOut: () => timeout,
    };
}
function abortBridgeError(url, timedOut, detail) {
    if (timedOut) {
        return new types_js_1.BridgeError("api_timeout", `Loopback request to ${url} exceeded the configured absolute timeout (${detail}). Set timeoutMs=0 to disable it.`);
    }
    return new types_js_1.BridgeError("api_aborted", `Loopback request was aborted (${detail}).`);
}
async function chatCompletionStream(cfg, req, onDelta, options = {}) {
    assertLoopbackApiRoot(cfg.apiRoot);
    const url = openAiEndpoint(cfg.apiRoot, "/chat/completions");
    const incoming = Array.isArray(req.messages) ? req.messages : [];
    (0, log_js_1.info)("api", "outgoing message shapes (pre-send)", {
        count: incoming.length,
        messages: incoming.map((m, i) => (0, messages_js_1.describeMessageShape)(m, i)),
    });
    const normalized = (0, messages_js_1.normalizeOpenAIMessages)(incoming);
    if (normalized.length !== incoming.length) {
        (0, log_js_1.warn)("api", "message count changed during normalization (invalid entries dropped)", {
            before: incoming.length,
            after: normalized.length,
        });
    }
    req = { ...req, messages: normalized };
    const body = JSON.stringify(req);
    (0, log_js_1.info)("api", "POST /v1/chat/completions (loopback)", {
        url,
        model: req.model,
        messages: req.messages.length,
        tools: req.tools?.length ?? 0,
        bodyBytes: body.length,
        timeoutMs: cfg.timeoutMs,
    });
    const startedAt = Date.now();
    safeCall(() => options.observer?.onRequestStart?.({ url, at: startedAt }));
    const abort = makeAbortController(cfg.timeoutMs, options.signal);
    let res;
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
        }
        catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            if (abort.signal.aborted)
                throw abortBridgeError(url, abort.timedOut(), detail);
            (0, log_js_1.err)("api", "connection to LM Studio API failed", { url, error: detail });
            throw new types_js_1.BridgeError("api_connect_failed", `Cannot connect to ${url} (${detail}). Check that LM Studio Local Server is enabled and apiRoot is correct.`);
        }
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        (0, log_js_1.dbg)("api", "HTTP response received", { status: res.status, contentType, ms: Date.now() - startedAt });
        safeCall(() => options.observer?.onConnected?.({ status: res.status, contentType, at: Date.now() }));
        if (res.status === 202) {
            const text = await res.text().catch(() => "");
            (0, log_js_1.err)("api", "request was queued (HTTP 202) — model busy; loopback deadlock risk", { body: text.slice(0, 500) });
            throw new types_js_1.BridgeError("api_queued", "LM Studio accepted the request as a background job (202). The nested loopback request may be queued behind the current prediction.");
        }
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            (0, log_js_1.err)("api", "non-OK response from LM Studio API", { status: res.status, body: text.slice(0, 1500) });
            throw new types_js_1.BridgeError("api_error", `LM Studio API returned ${res.status}: ${text.slice(0, 400)}`);
        }
        const state = {
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
                const processLine = (line) => {
                    const l = line.replace(/\r$/, "");
                    if (!l.startsWith("data:"))
                        return;
                    const payload = l.slice(5).trim();
                    if (!payload || payload === "[DONE]")
                        return;
                    let json;
                    try {
                        json = JSON.parse(payload);
                    }
                    catch {
                        (0, log_js_1.dbg)("api", "unparseable SSE data line", payload.slice(0, 200));
                        return;
                    }
                    handleChunk(json, state, onDelta, options.observer);
                };
                const stream = res.body;
                const reader = stream.getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        if (value && value.length > 0) {
                            safeCall(() => options.observer?.onNetworkActivity?.({ at: Date.now(), bytes: value.length }));
                            buffer += Buffer.from(value).toString("utf8");
                            const lines = buffer.split("\n");
                            buffer = lines.pop() ?? "";
                            for (const line of lines)
                                processLine(line);
                        }
                    }
                }
                finally {
                    reader.releaseLock?.();
                }
                if (buffer.trim().length > 0)
                    processLine(buffer);
            }
            else {
                const text = await res.text();
                safeCall(() => options.observer?.onNetworkActivity?.({ at: Date.now(), bytes: Buffer.byteLength(text) }));
                let json;
                try {
                    json = JSON.parse(text);
                }
                catch (e) {
                    throw new types_js_1.BridgeError("api_bad_json", `non-stream response was not valid JSON: ${e.message}`);
                }
                handleChunk(json, state, onDelta, options.observer, true);
                if (state.content.length > 0)
                    onDelta(state.content);
            }
        }
        catch (e) {
            if (abort.signal.aborted) {
                const detail = e instanceof Error ? e.message : String(e);
                throw abortBridgeError(url, abort.timedOut(), detail);
            }
            throw e;
        }
        const toolCalls = finishToolCalls(state);
        (0, log_js_1.info)("api", "loopback request complete", {
            viaStream: contentType.includes("text/event-stream"),
            contentChars: state.content.length,
            toolCalls: toolCalls.length,
            model: state.model,
            finishReason: state.finishReason,
            firstTokenMs: state.firstTokenAt === null ? null : state.firstTokenAt - startedAt,
            totalMs: Date.now() - startedAt,
        });
        if (toolCalls.length > 0)
            (0, log_js_1.info)("api", "model requested tool call(s)", toolCalls.map((t) => t.function.name));
        safeCall(() => options.observer?.onComplete?.({ at: Date.now(), finishReason: state.finishReason }));
        return {
            content: state.content,
            toolCalls,
            model: state.model,
            finishReason: state.finishReason,
            viaStream: contentType.includes("text/event-stream"),
        };
    }
    finally {
        abort.cleanup();
    }
}
