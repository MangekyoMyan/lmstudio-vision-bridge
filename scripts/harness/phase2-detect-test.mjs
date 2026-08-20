// Phase 2: MCP image detection — reference extraction + file resolution.
//
// Pure logic; no API, no model needed.
//
//   npm run phase2:detect
//
// Verifies that tool-result references (markdown image / "fileName:" style /
// URL-encoded names / free-text path tokens / file parts / multiple images)
// are matched ONTO the concrete files in the working directory — and that a
// tool result is never answered with "whatever is the newest file in the
// folder".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register(new URL("./loader-hooks.mjs", import.meta.url));

const { writeFixtureImage } = await import("./fixture-image.mjs");
const { refsFromToolResult, resolveImages } = await import("../../vision-bridge/build/index.js");

const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase2-"));
writeFixtureImage(path.join(wd, "scene.png"));
writeFixtureImage(path.join(wd, "assets", "render_001.png"));
writeFixtureImage(path.join(wd, "my shot.png"));
writeFixtureImage(path.join(wd, "old.png"));
fs.writeFileSync(path.join(wd, "notes.txt"), "not an image");
// make old.png OLDER than scene.png so "newest file" and "referenced file" differ
const past = Date.now() / 1000 - 86400;
fs.utimesSync(path.join(wd, "old.png"), past, past);

const MAX = 20 * 1024 * 1024;
let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function resolve(content) {
  const refs = refsFromToolResult({ role: "tool", content });
  const resolved = resolveImages(wd, refs, { maxImageBytes: MAX });
  return { refs, resolved, names: resolved.map((r) => path.basename(r.absPath)) };
}

// 1. markdown reference (documented LM Studio format) ------------------------
{
  const { refs, names } = resolve("Screenshot saved.\n![scene](scene.png)");
  check(refs.length >= 1, "1. markdown ref extracted", refs.map((r) => `${r.kind}:${r.value}`).join(" | ") || "(none)");
  check(names.length === 1 && names[0] === "scene.png", "1. resolved to the REFERENCED file (not the newest)", names.join(","));
}

// 2. "fileName:" style with a nested path ------------------------------------
{
  const { names } = resolve("Render complete.\nfileName: assets/render_001.png, mimeType: image/png");
  check(names.length === 1 && names[0] === "render_001.png", "2. fileName: ref resolved (nested path)", names.join(","));
}

// 3. URL-encoded filename with a space ---------------------------------------
{
  const { names } = resolve("image file: my%20shot.png");
  check(names.length === 1 && names[0] === "my shot.png", "3. URL-encoded filename resolved", names.join(","));
}

// 4. free-text mention (last-resort path token, swallowed leading words) -----
{
  const { names } = resolve("As you can see in my shot.png, the cube is rotating.");
  check(names.length === 1 && names[0] === "my shot.png", "4. free-text path token resolved (suffix retry)", names.join(","));
}

// 5. multiple images in one tool result ---------------------------------------
{
  fs.copyFileSync(path.join(wd, "scene.png"), path.join(wd, "copyA.png"));
  const { names } = resolve("Two shots:\n![a](copyA.png)\n![b](old.png)");
  check(
    names.length === 2 && names.includes("copyA.png") && names.includes("old.png"),
    "5. multiple images resolved",
    names.join(",")
  );
}

// 6. non-image reference must not resolve -------------------------------------
{
  const { names } = resolve("See notes.txt for details.");
  check(names.length === 0, "6. non-image reference not resolved", names.join(",") || "(none)");
}

// 7. no reference at all -------------------------------------------------------
{
  const { refs, names } = resolve("All done, nothing to show.");
  check(refs.length === 0 && names.length === 0, "7. no refs -> no images", `refs=${refs.length}`);
}

// 8. unresolvable reference: no crash, and NO fallback to "newest file" -------
{
  const { names } = resolve("![x](definitely-missing.png)");
  check(names.length === 0, "8. unresolvable ref -> empty result (no newest-file fallback)", names.join(",") || "(none)");
}

// 9. file parts inside a content array -----------------------------------------
{
  const msg = {
    role: "tool",
    content: [{ type: "text", text: "saved" }, { type: "file", path: "assets/render_001.png", mime_type: "image/png" }],
  };
  const refs = refsFromToolResult(msg);
  const resolved = resolveImages(wd, refs, { maxImageBytes: MAX });
  check(
    resolved.length === 1 && path.basename(resolved[0].absPath) === "render_001.png",
    "9. file-part ref resolved",
    resolved.map((r) => r.relativePath).join(",")
  );
}

console.log(`\nworking directory: ${wd}`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
