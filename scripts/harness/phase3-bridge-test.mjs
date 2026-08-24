// Phase 3: Vision Bridge pipeline — synthetic-message injection, dedup, and
// non-mutation of the LM Studio history.
//
// Pure logic (applyVisionBridge only); no API, no model needed.
//
//   npm run phase3:bridge
//
// Verifies:
//   1. a tool result with an image reference yields exactly ONE synthetic
//      user message (note text + image data URL) appended to the outgoing copy
//   2. re-running with the same history/image SKIPS the duplicate (content hash)
//   3. a NEW image in a later tool result IS injected; the old one stays skipped
//   4. text-only tool results leave the history unchanged
//   5. multiple images -> ONE synthetic message with MULTIPLE image parts
//   6. same path + same byte length + different content is NOT mistaken for a duplicate
//   7. the input history array is never mutated (internal copy only)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register(new URL("./loader-hooks.mjs", import.meta.url));

const { writeFixtureImage } = await import("./fixture-image.mjs");
const { applyVisionBridge, SeenTracker, loadConfig } = await import("../../vision-bridge/build/index.js");

const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase3-"));
writeFixtureImage(path.join(wd, "scene.png")); // red / blue  (default fixture)
writeFixtureImage(
  path.join(wd, "other.png"),
  (x) => (x < 32 ? [30, 200, 30] : [150, 30, 150]) // green / purple: DIFFERENT content
);
fs.writeFileSync(path.join(wd, "notes.txt"), "text only, no image");

const cfg = loadConfig(wd); // bridgeEnabled defaults to true
const ctl = { getWorkingDirectory: () => wd };
const seen = new SeenTracker(wd);

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function synthetic(out) {
  return out.messages[out.messages.length - 1];
}
function imgParts(m) {
  return Array.isArray(m && m.content) ? m.content.filter((p) => p.type === "image_url") : [];
}

const historyWithScene = () => [
  { role: "user", content: "Create a cube and show me a screenshot." },
  { role: "assistant", toolCallRequest: { id: "call_1", tool: "blender_screenshot", args: {} } },
  { role: "tool", tool_call_id: "call_1", content: "Screenshot saved.\nfileName: scene.png\n![](scene.png)" },
];

// 1. first injection ----------------------------------------------------------
{
  const history = historyWithScene();
  const before = JSON.stringify(history);
  const out = applyVisionBridge({ ctl, messages: history, cfg, seen });
  check(out.messages.length === history.length + 1, "1. exactly one synthetic message appended", `${history.length} -> ${out.messages.length}`);
  const m = synthetic(out);
  check(m.role === "user", "1. synthetic message role is user");
  const text = Array.isArray(m.content) ? m.content.find((p) => p.type === "text") : null;
  check(!!text && /Vision Bridge/i.test(text.text), "1. synthetic message carries the note text");
  const parts = imgParts(m);
  check(parts.length === 1 && /^data:image\/png;base64,/.test(parts[0].image_url.url), "1. carries one image data URL");
  check(out.injected.length === 1 && out.injected[0].relativePath === "scene.png", "1. injected metadata correct", JSON.stringify(out.injected));
  check(JSON.stringify(history) === before, "1. input history not mutated");
  console.log(`     [detail] synthetic content parts: text(${text ? text.text.length : 0} chars) + ${parts.length} image(s), dataUrl=${parts[0] ? parts[0].image_url.url.length : 0} chars`);
}

// 2. duplicate is skipped on the next round -----------------------------------
{
  const out = applyVisionBridge({ ctl, messages: historyWithScene(), cfg, seen });
  check(out.injected.length === 0, "2. duplicate image NOT re-injected");
  check(out.skippedDuplicates >= 1, "2. duplicate counted as skipped", `skipped=${out.skippedDuplicates}`);
  check(
    out.messages.length === 3,
    "2. history sent unchanged when all candidates are duplicates",
    `${out.messages.length} messages`
  );
}

// 3. a NEW image in a later tool result is injected ----------------------------
{
  const history = [
    ...historyWithScene(),
    { role: "user", content: "Now render it from the side and send the new screenshot." },
    { role: "assistant", toolCallRequest: { id: "call_2", tool: "blender_screenshot", args: {} } },
    { role: "tool", tool_call_id: "call_2", content: "New render saved.\nfileName: other.png\n![](other.png)" },
  ];
  const out = applyVisionBridge({ ctl, messages: history, cfg, seen });
  check(out.injected.length === 1 && out.injected[0].relativePath === "other.png", "3. only the NEW image is injected", JSON.stringify(out.injected));
  check(out.skippedDuplicates >= 1, "3. the old image is still skipped", `skipped=${out.skippedDuplicates}`);
  check(imgParts(synthetic(out)).length === 1, "3. synthetic message carries exactly one image");
}

// 4. text-only tool result: nothing changes ------------------------------------
// NOTE: SeenTracker persists to <wd>/.vision-bridge/state.json, so a "fresh"
// tracker in the shared wd still restores the state from scenarios 1-3.
// Isolate this case with a dedicated working directory (like scenario 5).
{
  const wd4 = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase3-text-"));
  fs.writeFileSync(path.join(wd4, "notes.txt"), "text only, no image");
  const ctl4 = { getWorkingDirectory: () => wd4 };
  const seen2 = new SeenTracker(wd4); // isolated: own wd -> own (empty) state
  const history = [
    { role: "user", content: "Tell me the scene info." },
    { role: "assistant", toolCallRequest: { id: "call_3", tool: "blender_scene_info", args: {} } },
    { role: "tool", tool_call_id: "call_3", content: "See notes.txt for details." },
  ];
  const out = applyVisionBridge({ ctl: ctl4, messages: history, cfg, seen: seen2 });
  check(out.injected.length === 0, "4. text-only tool result -> no injection");
  check(out.messages.length === history.length, "4. history length unchanged");
}

// 5. multiple images -> one synthetic message, multiple parts ------------------
// Isolated by design: scenarios 1-3 already registered scene.png/other.png in
// this wd's SeenTracker state, so reusing that tracker would (correctly) skip
// both as duplicates. This scenario exercises "several NEW images in one tool
// result -> one synthetic message with multiple parts", so it gets its own
// working directory, fresh fixture files, and a fresh SeenTracker.
{
  const wd5 = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase3-multi-"));
  writeFixtureImage(path.join(wd5, "scene.png")); // red / blue (default fixture)
  writeFixtureImage(
    path.join(wd5, "other.png"),
    (x) => (x < 32 ? [30, 200, 30] : [150, 30, 150]) // green / purple: DIFFERENT content
  );
  const ctl5 = { getWorkingDirectory: () => wd5 };
  const seen3 = new SeenTracker(wd5);
  const history = [
    { role: "user", content: "Show me both renders." },
    { role: "assistant", toolCallRequest: { id: "call_4", tool: "blender_multi", args: {} } },
    { role: "tool", tool_call_id: "call_4", content: "Saved both:\n![a](scene.png)\n![b](other.png)" },
  ];
  const out = applyVisionBridge({ ctl: ctl5, messages: history, cfg, seen: seen3 });
  check(out.messages.length === history.length + 1, "5. still only ONE synthetic message for multiple images");
  const parts = imgParts(synthetic(out));
  check(parts.length === 2, "5. synthetic message carries TWO image parts", `parts=${parts.length}`);
  check(out.injected.length === 2, "5. both images reported as injected", JSON.stringify(out.injected.map((i) => i.relativePath)));
}

// 6. overwrite same path with SAME BYTE LENGTH but different content ---------
{
  const wd6 = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase3-same-size-"));
  const file = path.join(wd6, "same.png");
  fs.writeFileSync(file, Buffer.from("AAAA"));
  const seen4 = new SeenTracker(wd6);
  const image = { absPath: file, relativePath: "same.png", mimeType: "image/png", sizeBytes: 4, matchedFrom: "test" };
  const a = seen4.registerIfNew(image, "call_a");
  fs.writeFileSync(file, Buffer.from("BBBB")); // same 4 bytes, different content
  const b = seen4.registerIfNew(image, "call_b");
  check(a.injected === true, "6. first same-size fixture is registered");
  check(b.injected === true, "6. overwritten same-size file is re-hashed and treated as new content");
}

console.log(`\nworking directory: ${wd}`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
