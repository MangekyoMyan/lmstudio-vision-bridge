/**
 * Standalone OpenAI-compatible Vision Bridge proxy.
 *
 * Client (Open WebUI, etc.) -> this server -> OpenAI-compatible upstream model.
 * The proxy preserves the incoming request and response as much as possible;
 * the only semantic request change is the Vision Bridge's synthetic image
 * message when a tool-result image can be resolved.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Built CommonJS modules are used intentionally so the proxy can share the
// exact same bridge/dedup/config code as the LM Studio Generator path.
const { loadConfig } = require("../build/src/config.js");
const { configure: configureLog, info, warn, err } = require("../build/src/log.js");
const { SeenTracker } = require("../build/src/dedup.js");
const { applyVisionBridgeToOpenAI } = require("../build/src/vision-bridge.js");
const { beginRuntime, patchRuntime, startAbortWatcher, startRuntimeHeartbeat } = require("../build/src/runtime-state.js");

const hostArg = process.argv.find((a) => a.startsWith("--host="));
const portArg = process.argv.find((a) => a.startsWith("--port="));
const cfgAtStart = loadConfig(null);
const host = hostArg ? hostArg.slice(7) : cfgAtStart.proxyHost;
const port = portArg ? Number(portArg.slice(7)) || cfgAtStart.proxyPort : cfgAtStart.proxyPort;
const proxySeenFile = path.join(os.homedir(), ".vision-bridge", "proxy-seen.json");

function openAiEndpoint(apiRoot, route) {
  const base = String(apiRoot || "").replace(/\/+$/, "");
  const r = route.startsWith("/") ? route : `/${route}`;
  return /\/v1$/i.test(base) ? `${base}${r}` : `${base}/v1${r}`;
}

function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...extra,
  });
  res.end(body);
}

function cors(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-max-age": "600",
  });
  res.end();
}

async function readJsonBody(req, maxBytes = 128 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`request body too large (${bytes} bytes; max ${maxBytes})`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(req, cfg) {
  if (!cfg.proxyApiKey) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${cfg.proxyApiKey}`;
}

function upstreamHeaders(cfg, req) {
  const out = {
    "content-type": "application/json",
    accept: req.headers.accept || "*/*",
  };
  if (cfg.openAiApiKey) out.authorization = `Bearer ${cfg.openAiApiKey}`;
  return out;
}

function makeAbort(timeoutMs) {
  const ctl = new AbortController();
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (!ctl.signal.aborted) ctl.abort(new Error(`absolute timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }
  return { ctl, cleanup: () => timer && clearTimeout(timer) };
}

function stringSize(v, depth = 0) {
  if (typeof v === "string") return v.length;
  if (v === null || v === undefined || depth > 2) return 0;
  if (Array.isArray(v)) return v.reduce((n, x) => n + stringSize(x, depth + 1), 0);
  if (typeof v === "object") return Object.values(v).slice(0, 20).reduce((n, x) => n + stringSize(x, depth + 1), 0);
  return 0;
}

function inspectOpenAIObject(json, invocationId) {
  if (!json || typeof json !== "object") return;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0] || {};
  const holder = choice.delta && typeof choice.delta === "object"
    ? choice.delta
    : choice.message && typeof choice.message === "object" ? choice.message : null;
  if (!holder) return;
  let reasoningChars = 0;
  for (const key of ["reasoning_content", "reasoning", "reasoning_text", "analysis"]) reasoningChars += stringSize(holder[key]);
  if (reasoningChars > 0) {
    const now = Date.now();
    const current = readRuntimeSafe();
    patchRuntime(invocationId, {
      phase: "reasoning",
      lastModelActivityAt: now,
      reasoningEvents: (current?.invocationId === invocationId ? current.reasoningEvents || 0 : 0) + 1,
      reasoningChars: (current?.invocationId === invocationId ? current.reasoningChars || 0 : 0) + reasoningChars,
    });
  }
  const contentChars = typeof holder.content === "string" ? holder.content.length : 0;
  if (contentChars > 0) {
    const now = Date.now();
    const current = readRuntimeSafe();
    patchRuntime(invocationId, {
      phase: "generating",
      lastModelActivityAt: now,
      textChars: (current?.invocationId === invocationId ? current.textChars || 0 : 0) + contentChars,
    });
  }
  const toolCount = Array.isArray(holder.tool_calls) ? holder.tool_calls.length : 0;
  if (toolCount > 0) {
    const now = Date.now();
    const current = readRuntimeSafe();
    patchRuntime(invocationId, {
      phase: "tool_call",
      lastModelActivityAt: now,
      toolEvents: (current?.invocationId === invocationId ? current.toolEvents || 0 : 0) + toolCount,
    });
  }
}

const runtimeFile = path.join(os.homedir(), ".vision-bridge", "runtime.json");
function readRuntimeSafe() {
  try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch { return null; }
}

function inspectSseText(text, invocationId, state) {
  state.buffer += text;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { inspectOpenAIObject(JSON.parse(payload), invocationId); } catch { /* passthrough remains authoritative */ }
  }
}

async function forwardModels(req, res, cfg) {
  // When a model override is configured, expose that one deterministic model
  // to the client. This also supports OpenAI-compatible servers that implement
  // chat completions but omit GET /v1/models.
  if (cfg.openAiModel) {
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: cfg.openAiModel, object: "model", owned_by: "vision-bridge" }],
    });
  }

  const upstream = openAiEndpoint(cfg.openAiApiRoot, "/models");
  try {
    const r = await fetch(upstream, { headers: upstreamHeaders(cfg, req) });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      "content-type": r.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch (e) {
    return sendJson(res, 502, { error: { message: `Cannot reach upstream /v1/models: ${e instanceof Error ? e.message : String(e)}` } });
  }
}

async function forwardChat(req, res, cfg) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e instanceof Error ? e.message : String(e) } }); }
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return sendJson(res, 400, { error: { message: "OpenAI-compatible request must contain messages[]." } });
  }

  const upstreamModel = cfg.openAiModel || (typeof body.model === "string" ? body.model : "");
  if (!upstreamModel) {
    return sendJson(res, 400, { error: { message: "No model id supplied. Set a model in the client or configure OpenAI model override in Vision Bridge." } });
  }

  configureLog(cfg.logLevel, cfg.logFile);
  const invocationId = `vbp-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const workingDirectory = cfg.proxyWorkingDirectory && cfg.proxyWorkingDirectory.trim() ? cfg.proxyWorkingDirectory.trim() : null;
  const seen = new SeenTracker(workingDirectory, proxySeenFile);

  beginRuntime({
    invocationId,
    phase: "preparing",
    startedAt: Date.now(),
    model: upstreamModel,
    apiRoot: cfg.openAiApiRoot,
    transportMode: "openai",
    timeoutMs: cfg.timeoutMs,
    workingDirectory,
    logFile: cfg.logFile,
    messageCount: body.messages.length,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    injectedImages: [],
    skippedImages: 0,
    note: "OpenAI-compatible proxy request received.",
  });
  const stopHeartbeat = startRuntimeHeartbeat(invocationId);
  const abort = makeAbort(cfg.timeoutMs);
  const stopAbortWatcher = startAbortWatcher(invocationId, () => {
    patchRuntime(invocationId, { note: "Abort requested from Vision Bridge GUI." });
    if (!abort.ctl.signal.aborted) abort.ctl.abort(new Error("aborted from Vision Bridge GUI"));
  });
  let finished = false;
  res.on("close", () => {
    if (!finished && !abort.ctl.signal.aborted) abort.ctl.abort(new Error("client disconnected"));
  });

  try {
    const bridge = applyVisionBridgeToOpenAI({
      messages: body.messages,
      cfg,
      seen,
      workingDirectory,
    });
    const outgoing = { ...body, model: upstreamModel, messages: bridge.messages };
    patchRuntime(invocationId, {
      phase: "connecting",
      requestStartedAt: Date.now(),
      messageCount: bridge.messages.length,
      injectedImages: bridge.injected.map((x) => x.relativePath),
      skippedImages: bridge.skippedDuplicates,
      note: `Forwarding to OpenAI-compatible upstream (${bridge.injected.length} image(s) injected).`,
    });

    const upstream = openAiEndpoint(cfg.openAiApiRoot, "/chat/completions");
    info("proxy", "forwarding /v1/chat/completions", {
      upstream,
      model: upstreamModel,
      messages: bridge.messages.length,
      stream: body.stream === true,
      injectedImages: bridge.injected.map((x) => x.relativePath),
    });

    let up;
    try {
      up = await fetch(upstream, {
        method: "POST",
        headers: upstreamHeaders(cfg, req),
        body: JSON.stringify(outgoing),
        signal: abort.ctl.signal,
      });
    } catch (e) {
      if (abort.ctl.signal.aborted) throw e;
      throw new Error(`Cannot connect to upstream ${upstream}: ${e instanceof Error ? e.message : String(e)}`);
    }

    patchRuntime(invocationId, {
      phase: "connected",
      connectedAt: Date.now(),
      lastNetworkActivityAt: Date.now(),
      note: up.ok ? "Upstream HTTP connection established." : `Upstream returned HTTP ${up.status}.`,
    });

    const contentType = up.headers.get("content-type") || "application/json; charset=utf-8";
    const headers = {
      "content-type": contentType,
      "cache-control": up.headers.get("cache-control") || "no-store",
      "access-control-allow-origin": "*",
    };
    res.writeHead(up.status, headers);

    if (!up.body) {
      finished = true;
      res.end();
      patchRuntime(invocationId, { phase: up.ok ? "completed" : "error", finishReason: null, error: up.ok ? undefined : `HTTP ${up.status}` });
      return;
    }

    if (contentType.toLowerCase().includes("text/event-stream")) {
      const reader = up.body.getReader();
      const inspectState = { buffer: "" };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          patchRuntime(invocationId, { lastNetworkActivityAt: Date.now() });
          inspectSseText(Buffer.from(value).toString("utf8"), invocationId, inspectState);
          if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
        }
        if (inspectState.buffer.trim()) inspectSseText("\n", invocationId, inspectState);
      } finally {
        try { reader.releaseLock(); } catch {}
      }
      finished = true;
      res.end();
    } else {
      const raw = Buffer.from(await up.arrayBuffer());
      patchRuntime(invocationId, { lastNetworkActivityAt: Date.now() });
      try { inspectOpenAIObject(JSON.parse(raw.toString("utf8")), invocationId); } catch {}
      finished = true;
      res.end(raw);
    }

    const phase = up.ok ? "completed" : "error";
    patchRuntime(invocationId, {
      phase,
      finishReason: null,
      note: up.ok ? "OpenAI-compatible proxy request completed." : undefined,
      error: up.ok ? undefined : `Upstream returned HTTP ${up.status}.`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = abort.ctl.signal.aborted;
    patchRuntime(invocationId, {
      phase: aborted ? "aborted" : "error",
      note: aborted ? "OpenAI-compatible proxy request aborted." : undefined,
      error: aborted ? undefined : msg,
    });
    if (!res.headersSent) sendJson(res, aborted ? 499 : 502, { error: { message: msg } });
    else if (!res.writableEnded) res.end();
    if (!aborted) err("proxy", "request failed", msg);
  } finally {
    finished = true;
    stopAbortWatcher();
    stopHeartbeat();
    abort.cleanup();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return cors(res);
    const cfg = loadConfig(null);
    if (cfg.mode !== "openai") {
      return sendJson(res, 503, { error: { message: "Vision Bridge is currently set to LM Studio mode. Switch Mode to OpenAI-compatible proxy in the Control Panel." } });
    }
    if (!authorized(req, cfg)) {
      return sendJson(res, 401, { error: { message: "Invalid Vision Bridge proxy API key." } }, { "www-authenticate": "Bearer" });
    }
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/v1/health")) {
      return sendJson(res, 200, {
        ok: true,
        service: "vision-bridge-openai-proxy",
        mode: cfg.mode,
        upstream: cfg.openAiApiRoot,
        modelOverride: cfg.openAiModel || null,
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") return forwardModels(req, res, cfg);
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return forwardChat(req, res, cfg);
    return sendJson(res, 404, { error: { message: `Unsupported endpoint: ${req.method} ${url.pathname}. Supported: GET /v1/models, POST /v1/chat/completions.` } });
  } catch (e) {
    return sendJson(res, 500, { error: { message: e instanceof Error ? e.message : String(e) } });
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("error", (e) => {
  console.error(`[Vision Bridge Proxy] failed to listen on ${host}:${port}: ${e.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[Vision Bridge Proxy] listening on http://${host}:${port}/v1`);
  console.log(`[Vision Bridge Proxy] Docker/Open WebUI URL: http://host.docker.internal:${port}/v1`);
  console.log(`[Vision Bridge Proxy] upstream: ${cfgAtStart.openAiApiRoot}`);
});
