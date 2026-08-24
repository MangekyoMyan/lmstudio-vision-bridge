// Runtime/GUI control regression test.
// Proves that timeoutMs=0 allows a long/silent request to remain alive,
// reasoning stream activity is visible in runtime telemetry, and an external
// GUI-style abort request stops the loopback promptly.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { generate } = await import("../../vision-bridge/build/index.js");

const port = 18997;
const apiRoot = `http://127.0.0.1:${port}`;
const appDir = path.join(os.homedir(), ".vision-bridge");
const runtimeFile = path.join(appDir, "runtime.json");
const controlFile = path.join(appDir, "control.json");
const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase4-control-"));
fs.mkdirSync(appDir, { recursive: true });
try { fs.unlinkSync(controlFile); } catch {}

process.env.VISION_BRIDGE_API_ROOT = apiRoot;
process.env.VISION_BRIDGE_TIMEOUT_MS = "0";
process.env.VISION_BRIDGE_LOG_LEVEL = "warn";

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function readRuntime() {
  try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch { return null; }
}
async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = pred();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const sockets = new Set();
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => raw += c);
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // Emit a reasoning-only event, then deliberately remain open forever.
    res.write(`data: ${JSON.stringify({
      id: "reasoning-test", model: "mock-reasoner",
      choices: [{ index: 0, delta: { reasoning_content: "internal reasoning activity" } }],
    })}\n\n`);
  });
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

const report = { fragments: [] };
const ctl = {
  getWorkingDirectory: () => wd,
  getToolDefinitions: () => [],
  fragmentGenerated: (t) => report.fragments.push(t),
  abortSignal: new AbortController().signal,
};

const run = generate(ctl, [{ role: "user", content: "Keep thinking until I stop you." }]);

const reasoningState = await waitFor(() => {
  const r = readRuntime();
  return r?.phase === "reasoning" && r.reasoningEvents >= 1 ? r : null;
});
check(!!reasoningState, "reasoning-only stream activity becomes visible in runtime telemetry",
  reasoningState ? `events=${reasoningState.reasoningEvents}, chars=${reasoningState.reasoningChars}` : "no reasoning state");

await new Promise((r) => setTimeout(r, 700));
const stillAlive = readRuntime();
check(stillAlive && ["reasoning", "connected"].includes(stillAlive.phase),
  "timeoutMs=0 does not kill a quiet long-running request", `phase=${stillAlive?.phase ?? "?"}`);

if (stillAlive?.invocationId) {
  fs.writeFileSync(controlFile, JSON.stringify({ abortInvocationId: stillAlive.invocationId, requestedAt: Date.now() }), "utf8");
}
await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("abort did not complete")), 5000))]);

const finalState = readRuntime();
check(finalState?.phase === "aborted", "GUI-style control file abort stops the request", `phase=${finalState?.phase ?? "?"}`);
check(report.fragments.join("").includes("aborted"), "abort is surfaced to the LM Studio output", report.fragments.join("").slice(0, 180));

server.close();
if (typeof server.closeAllConnections === "function") server.closeAllConnections();
for (const s of sockets) { try { s.destroy(); } catch {} }
try { fs.unlinkSync(controlFile); } catch {}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
