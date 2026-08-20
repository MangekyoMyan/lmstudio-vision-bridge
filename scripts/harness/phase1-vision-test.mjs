// Phase 1b: Vision input through the loopback path.
//
//   npm run phase1:vision            -> real LM Studio + loaded Qwen3.8-27B
//   npm run phase1:vision -- --mock  -> structural proof: the image data URL
//                                      actually reaches the (mock) model side
//
// Scenario 1 (manual attach): user message with an image file part — the same
//   path the UI's manual attach uses. Qwen must describe the two colors.
// Scenario 2 (MCP bridge):    a fake tool result referencing scene.png; the
//   bridge must detect it, resolve it from the working directory and inject a
//   synthetic image message (internal copy only — input history untouched).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register(new URL("./loader-hooks.mjs", import.meta.url));

const { writeFixtureImage } = await import("./fixture-image.mjs");
const { BaseController } = await import("./mock-lmstudio.mjs");
const { startMockApi } = await import("./mock-api.mjs");
const { VisionBridgeGenerator } = await import("../../vision-bridge/build/index.js");

const useMock = process.argv.includes("--mock") || process.env.VB_FORCE_MOCK === "1";
process.env.VISION_BRIDGE_LOG_LEVEL = process.env.VISION_BRIDGE_LOG_LEVEL || "info";

let mock = null;
if (useMock) {
  mock = await startMockApi();
  process.env.VISION_BRIDGE_API_ROOT = mock.url;
  console.log(`[harness] mock API at ${mock.url} (structural vision check)`);
} else {
  console.log("[harness] targeting the real LM Studio API (load Qwen3.8-27B first; npm run api:smoke)");
}

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function run(gen, messages) {
  let out = "";
  for await (const t of gen.generate(messages)) out += t;
  return out;
}

const errMsg = (s) => (s && s.startsWith("⚠️") ? s.slice(0, 300) : null);

// --- Scenario 1: manual attach path (like attaching the image in the UI) ----
{
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-p1-manual-"));
  writeFixtureImage(path.join(wd, "scene.png"));
  const ctl = new BaseController({ workingDirectory: wd, tools: [] });
  const gen = new VisionBridgeGenerator(ctl);
  const out = await run(gen, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I am attaching an image. It has two solid color halves. What are the two colors? Answer with just the two color names.",
        },
        { type: "file", path: "scene.png", mime_type: "image/png" },
      ],
    },
  ]);
  const err = errMsg(out);
  if (err) {
    check(false, "manual-attach path completed", `ERROR: ${err}`);
  } else if (useMock) {
    const req = mock.state.last;
    check(!!req && req.imageCount >= 1, "image data URL reached the model side (manual attach)", `imageCount=${req ? req.imageCount : "?"}`);
    check(out.includes("MOCK-VISION-OK"), "model side acknowledged the image", out.trim().slice(0, 120));
  } else {
    check(
      /red/i.test(out) && /blue/i.test(out),
      "Qwen recognized both colors (red & blue)",
      `model said: "${out.trim().slice(0, 200)}"`
    );
  }
}

// --- Scenario 2: MCP tool result -> Vision Bridge injection -----------------
{
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-p1-mcp-"));
  writeFixtureImage(path.join(wd, "scene.png"));
  const ctl = new BaseController({ workingDirectory: wd, tools: [] });
  const gen = new VisionBridgeGenerator(ctl);
  const history = [
    { role: "user", content: "Take a screenshot of the scene. It has two solid color halves. What are the two colors? Answer with just the two color names." },
    { role: "assistant", toolCallRequest: { id: "call_shot", tool: "blender_take_screenshot", args: {} } },
    {
      role: "tool",
      tool_call_id: "call_shot",
      content: "Screenshot saved to the working directory.\nfileName: scene.png\n![](scene.png)",
    },
  ];
  const historySnapshot = JSON.stringify(history);
  const out = await run(gen, history);
  const err = errMsg(out);
  if (err) {
    check(false, "MCP bridge path completed", `ERROR: ${err}`);
  } else if (useMock) {
    const req = mock.state.last;
    check(
      !!req && req.imageCount >= 1,
      "bridge injected the MCP image into the outgoing copy",
      `imageCount=${req ? req.imageCount : "?"} messageCount=${req ? req.messageCount : "?"}`
    );
    check(out.includes("MOCK-VISION-OK"), "model side acknowledged the image", out.trim().slice(0, 120));
  } else {
    check(
      /red/i.test(out) && /blue/i.test(out),
      "Qwen recognized the MCP-returned image (red & blue)",
      `model said: "${out.trim().slice(0, 200)}"`
    );
  }
  check(JSON.stringify(history) === historySnapshot, "input history array was not mutated");
}

if (mock) await mock.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
// Graceful shutdown: set the exit code and let the event loop drain instead
// of calling process.exit(). A forced exit while the mock server / client
// sockets are still mid-close trips libuv's UV_HANDLE_CLOSING assertion on
// Windows (Node 24). The unref'd grace timer only fires if something else
// keeps the loop alive (e.g. a ref'd AbortSignal timeout timer inside the
// bridge client); by then all sockets are fully closed, so exiting there is
// safe.
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => {
  process.exit(process.exitCode);
}, 3000).unref?.();
