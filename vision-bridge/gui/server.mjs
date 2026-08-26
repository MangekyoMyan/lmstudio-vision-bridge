import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const publicDir = path.join(here, "public");
const appDir = path.join(os.homedir(), ".vision-bridge");
const configFile = path.join(appDir, "config.json");
const runtimeFile = path.join(appDir, "runtime.json");
const controlFile = path.join(appDir, "control.json");
const proxySeenFile = path.join(appDir, "proxy-seen.json");
const host = "127.0.0.1";
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice(7)) || 19280 : 19280;
const withLmsDev = process.argv.includes("--with-lms-dev");
const noOpen = process.argv.includes("--no-open");

fs.mkdirSync(appDir, { recursive: true });

const devLog = [];
const proxyLog = [];
let devProcess = null;
let proxyProcess = null;
let devState = withLmsDev ? "not-started" : "not-managed";
let proxyState = "not-started";

function pushLog(target, source, chunk) {
  const text = String(chunk ?? "");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    target.push(`${new Date().toLocaleTimeString()} [${source}] ${line}`);
  }
  if (target.length > 500) target.splice(0, target.length - 500);
}
function pushDevLog(source, chunk) { pushLog(devLog, source, chunk); }
function pushProxyLog(source, chunk) { pushLog(proxyLog, source, chunk); }

function readJson(file, fallback = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function effectiveConfig() {
  const c = readJson(configFile, {});
  return {
    ...c,
    mode: c.mode === "openai" ? "openai" : "lmstudio",
    proxyHost: typeof c.proxyHost === "string" && c.proxyHost ? c.proxyHost : "0.0.0.0",
    proxyPort: Number.isFinite(Number(c.proxyPort)) && Number(c.proxyPort) > 0 ? Math.floor(Number(c.proxyPort)) : 19281,
    proxyApiKey: c.proxyApiKey === undefined ? "vision-bridge" : String(c.proxyApiKey ?? ""),
    openAiApiRoot: typeof c.openAiApiRoot === "string" && c.openAiApiRoot ? c.openAiApiRoot : "http://127.0.0.1:8080/v1",
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tailFile(file, maxLines = 250) {
  try {
    const stat = fs.statSync(file);
    const maxBytes = 512 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".js" ? "text/javascript; charset=utf-8"
    : ext === ".css" ? "text/css; charset=utf-8"
    : "application/octet-stream";
}

const allowedConfig = new Set([
  "mode",
  "apiRoot", "apiKey", "model",
  "openAiApiRoot", "openAiApiKey", "openAiModel",
  "proxyHost", "proxyPort", "proxyApiKey", "proxyWorkingDirectory",
  "timeoutMs", "maxImageBytes", "logLevel",
  "bridgeEnabled", "syntheticText", "requoteOriginalRequest",
]);

function proxyInfo() {
  const c = effectiveConfig();
  return {
    state: proxyState,
    pid: proxyProcess?.pid ?? null,
    host: c.proxyHost,
    port: c.proxyPort,
    windowsUrl: `http://127.0.0.1:${c.proxyPort}/v1`,
    dockerUrl: `http://host.docker.internal:${c.proxyPort}/v1`,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/api/status" && req.method === "GET") {
      const runtime = readJson(runtimeFile, null);
      const config = readJson(configFile, {});
      return sendJson(res, 200, {
        runtime,
        config: {
          ...config,
          apiKey: config.apiKey ? "••••••••" : "",
          openAiApiKey: config.openAiApiKey ? "••••••••" : "",
          proxyApiKey: config.proxyApiKey ? "••••••••" : (config.proxyApiKey === "" ? "" : undefined),
        },
        configFile,
        runtimeFile,
        dev: { state: devState, pid: devProcess?.pid ?? null },
        proxy: proxyInfo(),
        now: Date.now(),
      });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const current = readJson(configFile, {});
      for (const [key, value] of Object.entries(body)) {
        if (!allowedConfig.has(key)) continue;
        if (["apiKey", "openAiApiKey", "proxyApiKey"].includes(key) && value === "••••••••") continue;
        current[key] = value;
      }
      current.mode = current.mode === "openai" ? "openai" : "lmstudio";
      if (current.timeoutMs !== undefined) {
        const n = Number(current.timeoutMs);
        current.timeoutMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      }
      if (current.maxImageBytes !== undefined) {
        const n = Number(current.maxImageBytes);
        if (!Number.isFinite(n) || n <= 0) delete current.maxImageBytes;
        else current.maxImageBytes = Math.floor(n);
      }
      if (current.proxyPort !== undefined) {
        const n = Number(current.proxyPort);
        current.proxyPort = Number.isFinite(n) && n >= 1024 && n <= 65535 ? Math.floor(n) : 19281;
      }
      atomicWrite(configFile, current);
      await syncWorkers(true);
      return sendJson(res, 200, { ok: true, configFile, mode: current.mode, proxy: proxyInfo() });
    }

    if (url.pathname === "/api/abort" && req.method === "POST") {
      const runtime = readJson(runtimeFile, null);
      if (!runtime?.invocationId || ["completed", "aborted", "error"].includes(runtime.phase)) {
        return sendJson(res, 409, { ok: false, error: "No active Vision Bridge request." });
      }
      atomicWrite(controlFile, { abortInvocationId: runtime.invocationId, requestedAt: Date.now() });
      return sendJson(res, 200, { ok: true, invocationId: runtime.invocationId });
    }

    if (url.pathname === "/api/reset-dedup" && req.method === "POST") {
      const c = effectiveConfig();
      if (c.mode === "openai") {
        try { fs.unlinkSync(proxySeenFile); } catch (e) { if (e?.code !== "ENOENT") throw e; }
        return sendJson(res, 200, { ok: true, state: proxySeenFile, mode: "openai" });
      }
      const runtime = readJson(runtimeFile, null);
      const wd = typeof runtime?.workingDirectory === "string" ? runtime.workingDirectory : null;
      if (!wd) return sendJson(res, 409, { ok: false, error: "Working directory is not known yet." });
      const state = path.join(wd, ".vision-bridge", "state.json");
      try { fs.unlinkSync(state); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      return sendJson(res, 200, { ok: true, state, mode: "lmstudio" });
    }

    if (url.pathname === "/api/log" && req.method === "GET") {
      const runtime = readJson(runtimeFile, null);
      const logFile = typeof runtime?.logFile === "string" ? runtime.logFile : null;
      return sendJson(res, 200, { logFile, text: logFile ? tailFile(logFile) : "" });
    }

    if (url.pathname === "/api/dev-log" && req.method === "GET") {
      return sendJson(res, 200, { state: devState, text: devLog.slice(-250).join("\n") });
    }

    if (url.pathname === "/api/proxy-log" && req.method === "GET") {
      return sendJson(res, 200, { state: proxyState, text: proxyLog.slice(-250).join("\n"), ...proxyInfo() });
    }

    let requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    requestPath = decodeURIComponent(requestPath);
    const file = path.resolve(publicDir, `.${requestPath}`);
    if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, "index.html")) {
      return sendText(res, 403, "Forbidden");
    }
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      return res.end(data);
    } catch {
      return sendText(res, 404, "Not found");
    }
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

function openBrowser(url) {
  if (noOpen) return;
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
  p.unref();
}

function startLmsDev() {
  if (!withLmsDev || devProcess) return;
  pushDevLog("gui", `starting lms dev in ${pluginDir}`);
  const child = spawn("lms", ["dev"], {
    cwd: pluginDir,
    shell: process.platform === "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  devProcess = child;
  devState = "running";
  child.stdout?.on("data", (d) => pushDevLog("lms", d));
  child.stderr?.on("data", (d) => pushDevLog("lms:err", d));
  child.on("error", (e) => {
    if (devProcess !== child) return;
    devState = "error";
    pushDevLog("gui", `failed to start lms dev: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    if (devProcess !== child) return;
    devProcess = null;
    devState = code === 0 ? "stopped" : "error";
    pushDevLog("gui", `lms dev exited code=${String(code)} signal=${String(signal)}`);
  });
}

function stopLmsDev(reason = "mode changed") {
  const child = devProcess;
  if (!child) {
    devState = withLmsDev ? "disabled-by-mode" : "not-managed";
    return;
  }
  devProcess = null;
  pushDevLog("gui", `stopping lms dev (${reason})`);
  try { child.kill(); } catch {}
  devState = "disabled-by-mode";
}

function startProxy() {
  if (proxyProcess) return;
  const c = effectiveConfig();
  const proxyScript = path.join(pluginDir, "proxy", "server.mjs");
  pushProxyLog("gui", `starting proxy ${c.proxyHost}:${c.proxyPort} -> ${c.openAiApiRoot}`);
  const child = spawn(process.execPath, [proxyScript, `--host=${c.proxyHost}`, `--port=${c.proxyPort}`], {
    cwd: pluginDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess = child;
  proxyState = "running";
  child.stdout?.on("data", (d) => pushProxyLog("proxy", d));
  child.stderr?.on("data", (d) => pushProxyLog("proxy:err", d));
  child.on("error", (e) => {
    if (proxyProcess !== child) return;
    proxyState = "error";
    pushProxyLog("gui", `failed to start proxy: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    if (proxyProcess !== child) return;
    proxyProcess = null;
    proxyState = code === 0 ? "stopped" : "error";
    pushProxyLog("gui", `proxy exited code=${String(code)} signal=${String(signal)}`);
  });
}

function stopProxy(reason = "mode changed") {
  const child = proxyProcess;
  if (!child) {
    proxyState = "disabled-by-mode";
    return;
  }
  proxyProcess = null;
  pushProxyLog("gui", `stopping proxy (${reason})`);
  try { child.kill(); } catch {}
  proxyState = "disabled-by-mode";
}

async function syncWorkers(forceRestartProxy = false) {
  const c = effectiveConfig();
  if (c.mode === "openai") {
    stopLmsDev("OpenAI-compatible mode selected");
    if (forceRestartProxy && proxyProcess) {
      stopProxy("settings changed");
      // Give Windows a moment to release the listen socket before rebinding.
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    startProxy();
  } else {
    stopProxy("LM Studio mode selected");
    if (withLmsDev) startLmsDev();
    else devState = "not-managed";
  }
}

function shutdown() {
  if (devProcess && !devProcess.killed) { try { devProcess.kill(); } catch {} }
  if (proxyProcess && !proxyProcess.killed) { try { proxyProcess.kill(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log(`[Vision Bridge GUI] ${url}`);
  console.log(`[Vision Bridge GUI] config: ${configFile}`);
  syncWorkers(false).catch((e) => console.error(`[Vision Bridge GUI] worker sync failed: ${e.message}`));
  openBrowser(url);
});
