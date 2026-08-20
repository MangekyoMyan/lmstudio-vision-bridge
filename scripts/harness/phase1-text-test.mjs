// Phase 1a: loopback text inference + tool-call reporting + tool-result round trip.
//
//   npm run phase1:text            -> loopback to the REAL LM Studio API
//   npm run phase1:text -- --mock  -> loopback to an in-process mock OpenAI API
//                                     (deterministic pipeline check, no model needed)
//
// What it proves:
//   A. the generator is invoked by (mock) LM Studio and its loopback HTTP request
//      to /v1/chat/completions succeeds, and the streamed answer comes back
//   B. when the model side returns a tool call, the generator reports it to the
//      controller via report_tool_call (LM Studio would then run the MCP tool)
//   C. a history containing assistant toolCallRequest + tool result converts
//      cleanly and round-trips (second inference round) without breaking

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

// (Re)register the mock "lmstudio" SDK loader so this file works even when
// invoked without the `--import scripts/harness/register-mock.mjs` prefix.
register(new URL("./loader-hooks.mjs", import.meta.url));

const { BaseController } = await import("./mock-lmstudio.mjs");
const { startMockApi } = await import("./mock-api.mjs");
const { VisionBridgeGenerator } = await import("../../vision-bridge/build/index.js");

const useMock = process.argv.includes("--mock") || process.env.VB_FORCE_MOCK === "1";
process.env.VISION_BRIDGE_LOG_LEVEL = process.env.VISION_BRIDGE_LOG_LEVEL || "info";

const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase1-text-"));
const toolDef = {
  type: "function",
  function: {
    name: "mock_tool",
    description: "Harness tool used to verify tool-call reporting.",
    parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
  },
};

let mock = null;
if (useMock) {
  mock = await startMockApi();
  process.env.VISION_BRIDGE_API_ROOT = mock.url;
  console.log(`[harness] mock API at ${mock.url} (deterministic pipeline mode)`);
} else {
  console.log("[harness] targeting the real LM Studio API (load Qwen3.8-27B first; npm run api:smoke)");
}

const ctl = new BaseController({ workingDirectory: wd, tools: [] });
const gen = new VisionBridgeGenerator(ctl);

let failures = 0;
let warns = 0;
function check(ok, label, detail, { soft = false } = {}) {
  const pass = ok ? "PASS" : soft ? "WARN" : "FAIL";
  console.log(`${pass} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) (soft ? (warns += 1) : (failures += 1));
}

async function run(messages) {
  let out = "";
  for await (const t of gen.generate(messages)) out += t;
  return out;
}

const errMsg = (s) => (s && s.startsWith("⚠️") ? s.slice(0, 300) : null);

// --- A. plain text round trip (no tools) -----------------------------------
{
  ctl.tools = [];
  const out = await run([{ role: "user", content: "Respond with exactly the token BRIDGE-OK and nothing else." }]);
  const err = errMsg(out);
  check(
    !err,
    "loopback text inference works",
    err
      ? `ERROR: ${err} — is LM Studio's local server running? Try: npm run phase1:text -- --mock`
      : `model said: "${out.trim().slice(0, 120)}"`
  );
  check(out.includes("BRIDGE-OK"), "model produced the marker token", useMock ? "" : "soft check (real model variability)");
}

// --- B. model-side tool call -> generator reports it to LM Studio -----------
{
  ctl.tools = [toolDef];
  ctl.reportedToolCalls.length = 0;
  const before = ctl.reportedToolCalls.length;
  const out = await run([{ role: "user", content: 'Call the mock_tool tool now with argument {"x": 1}.' }]);
  const reported = ctl.reportedToolCalls.slice(before);
  const err = errMsg(out);
  check(
    !err,
    "tool-call round completed without API error",
    err ? `ERROR: ${err}` : "",
    { soft: false }
  );
  check(
    reported.length >= 1,
    "generator reported a tool call to the controller",
    `reported=${reported.length}`,
    useMock ? {} : { soft: true }
  );
  if (reported[0]) {
    check(
      reported[0].tool === "mock_tool" && reported[0].args && reported[0].args.x === 1 && typeof reported[0].id === "string",
      "reported tool call payload is well-formed (id/tool/args)",
      JSON.stringify(reported[0])
    );
  }
}

// --- C. updated history (assistant toolCallRequest + tool result) round-trips
{
  ctl.tools = [toolDef];
  ctl.reportedToolCalls.length = 0;
  const before = ctl.reportedToolCalls.length;
  const out = await run([
    { role: "user", content: 'Call the mock_tool tool now with argument {"x": 1}.' },
    { role: "assistant", toolCallRequest: { id: "call_1", tool: "mock_tool", args: { x: 1 } } },
    { role: "tool", tool_call_id: "call_1", content: "tool result: ok (x=1)" },
  ]);
  const err = errMsg(out);
  check(!err, "tool-result history round-trips without error", err ? `ERROR: ${err}` : `model said: "${out.trim().slice(0, 120)}"`);
  check(out.length > 0, "second round produced a response", useMock ? "" : "soft check");
  check(ctl.reportedToolCalls.length === before, "no spurious tool call reported in round 2");
}

if (mock) {
  await mock.close();
}
console.log(`\n${failures === 0 ? "ALL HARD CHECKS PASSED" : failures + " HARD CHECK(S) FAILED"}${warns > 0 ? ` (${warns} soft warn(s))` : ""}`);
if (!useMock && warns > 0) {
  console.log("Note: soft WARNs reflect real-model variability. For the deterministic pipeline check run: npm run phase1:text -- --mock");
}
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
