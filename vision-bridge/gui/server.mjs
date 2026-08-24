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
const host = "127.0.0.1";
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice(7)) || 19280 : 19280;
const withLmsDev = process.argv.includes("--with-lms-dev");
const noOpen = process.argv.includes("--no-open");

fs.mkdirSync(appDir, { recursive: true });

const devLog = [];
let devProcess = null;
let devState = withLmsDev ? "starting" : "not-started";

function pushDevLog(source, chunk) {
  const text = String(chunk ?? "");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    devLog.push(`${new Date().toLocaleTimeString()} [${source}] ${line}`);
  }
  if (devLog.length > 400) devLog.splice(0, devLog.length - 400);
}

function readJson(file, fallback = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
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
  "apiRoot", "apiKey", "model", "timeoutMs", "maxImageBytes", "logLevel",
  "bridgeEnabled", "syntheticText", "requoteOriginalRequest",
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/api/status" && req.method === "GET") {
      const runtime = readJson(runtimeFile, null);
      const config = readJson(configFile, {});
      return sendJson(res, 200, {
        runtime,
        config: { ...config, apiKey: config.apiKey ? "••••••••" : "" },
        configFile,
        runtimeFile,
        dev: { state: devState, pid: devProcess?.pid ?? null },
        now: Date.now(),
      });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const current = readJson(configFile, {});
      for (const [key, value] of Object.entries(body)) {
        if (!allowedConfig.has(key)) continue;
        if (key === "apiKey" && value === "••••••••") continue;
        current[key] = value;
      }
      if (current.timeoutMs !== undefined) {
        const n = Number(current.timeoutMs);
        current.timeoutMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      }
      if (current.maxImageBytes !== undefined) {
        const n = Number(current.maxImageBytes);
        if (!Number.isFinite(n) || n <= 0) delete current.maxImageBytes;
        else current.maxImageBytes = Math.floor(n);
      }
      atomicWrite(configFile, current);
      return sendJson(res, 200, { ok: true, configFile });
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
      const runtime = readJson(runtimeFile, null);
      const wd = typeof runtime?.workingDirectory === "string" ? runtime.workingDirectory : null;
      if (!wd) return sendJson(res, 409, { ok: false, error: "Working directory is not known yet." });
      const state = path.join(wd, ".vision-bridge", "state.json");
      try { fs.unlinkSync(state); } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
      return sendJson(res, 200, { ok: true, state });
    }

    if (url.pathname === "/api/log" && req.method === "GET") {
      const runtime = readJson(runtimeFile, null);
      const logFile = typeof runtime?.logFile === "string" ? runtime.logFile : null;
      return sendJson(res, 200, { logFile, text: logFile ? tailFile(logFile) : "" });
    }

    if (url.pathname === "/api/dev-log" && req.method === "GET") {
      return sendJson(res, 200, { state: devState, text: devLog.slice(-250).join("\n") });
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
  if (!withLmsDev) return;
  pushDevLog("gui", `starting lms dev in ${pluginDir}`);
  devProcess = spawn("lms", ["dev"], {
    cwd: pluginDir,
    shell: process.platform === "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  devState = "running";
  devProcess.stdout?.on("data", (d) => pushDevLog("lms", d));
  devProcess.stderr?.on("data", (d) => pushDevLog("lms:err", d));
  devProcess.on("error", (e) => {
    devState = "error";
    pushDevLog("gui", `failed to start lms dev: ${e.message}`);
  });
  devProcess.on("exit", (code, signal) => {
    devState = code === 0 ? "stopped" : "error";
    pushDevLog("gui", `lms dev exited code=${String(code)} signal=${String(signal)}`);
  });
}

function shutdown() {
  if (devProcess && !devProcess.killed) {
    try { devProcess.kill(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log(`[Vision Bridge GUI] ${url}`);
  console.log(`[Vision Bridge GUI] config: ${configFile}`);
  startLmsDev();
  openBrowser(url);
});
