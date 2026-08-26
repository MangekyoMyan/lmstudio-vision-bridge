// Phase 5: standalone OpenAI-compatible proxy.
// Verifies that the new adapter can sit between Open WebUI-style clients and
// an OpenAI-compatible upstream WITHOUT changing the existing LM Studio path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockApi, MOCK_MODEL_ID } from "./mock-api.mjs";
import { writeFixtureImage } from "./fixture-image.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const proxyScript = path.join(root, "vision-bridge", "proxy", "server.mjs");
const upstreamPort = 19031;
const proxyPort = 19032;
const mock = await startMockApi({ port: upstreamPort });
const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-proxy-wd-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vb-proxy-home-"));
writeFixtureImage(path.join(wd, "scene.png"));

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  VISION_BRIDGE_MODE: "openai",
  VISION_BRIDGE_OPENAI_API_ROOT: `${mock.url}/v1`, // explicitly test /v1-suffixed input
  VISION_BRIDGE_OPENAI_MODEL: MOCK_MODEL_ID,
  VISION_BRIDGE_PROXY_API_KEY: "proxy-test-key",
  VISION_BRIDGE_PROXY_WORKING_DIRECTORY: wd,
  VISION_BRIDGE_LOG_LEVEL: "error",
};
const child = spawn(process.execPath, [proxyScript, "--host=127.0.0.1", `--port=${proxyPort}`], {
  cwd: path.join(root, "vision-bridge"), env, stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => childLog += d.toString());
child.stderr.on("data", (d) => childLog += d.toString());

async function waitReady() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/health`, { headers: { authorization: "Bearer proxy-test-key" } });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

try {
  const ready = await waitReady();
  check(ready, "proxy starts and health endpoint responds", childLog.trim().slice(-220));
  if (!ready) throw new Error("proxy did not start");

  {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    check(r.status === 401, "output API key is enforced", `status=${r.status}`);
  }

  {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { headers: { authorization: "Bearer proxy-test-key" } });
    const j = await r.json();
    check(r.ok && Array.isArray(j.data) && j.data.some((m) => m.id === MOCK_MODEL_ID), "GET /v1/models is proxied", JSON.stringify(j).slice(0,160));
  }

  {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy-test-key" },
      body: JSON.stringify({ model: "client-model-is-overridden", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const text = await r.text();
    check(r.ok && text.includes("BRIDG") && text.includes("E-OK"), "streaming chat response passes through", text.slice(0,180));
    check(mock.state.last?.model === MOCK_MODEL_ID, "optional upstream model override works", `model=${mock.state.last?.model}`);
  }

  {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy-test-key" },
      body: JSON.stringify({
        model: MOCK_MODEL_ID,
        stream: true,
        messages: [
          { role: "user", content: "Take a screenshot and inspect it." },
          { role: "assistant", content: "", tool_calls: [{ id: "call_shot", type: "function", function: { name: "shot", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_shot", content: "Screenshot saved.\nfileName: scene.png\n![](scene.png)" },
        ],
      }),
    });
    const text = await r.text();
    check(r.ok && text.includes("MOCK-VISION-OK"), "proxy injects MCP image before upstream model", text.slice(0,200));
    check(mock.state.last?.imageCount === 1, "upstream received exactly one injected image", `imageCount=${mock.state.last?.imageCount}`);
  }
} catch (e) {
  check(false, "phase5 test completed", e instanceof Error ? e.message : String(e));
} finally {
  try { child.kill(); } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 1200).unref?.();
  });
  await mock.close();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
