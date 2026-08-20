/**
 * Phase 2: MCP image detection (prebuilt mirror of src/image-detect.ts).
 * Matches tool-result references (markdown / "fileName:" / path tokens /
 * file parts) onto concrete image files in the working directory.
 * NOT "newest file wins".
 */
import fs from "node:fs";
import path from "node:path";
import { dbg, info, warn } from "./log.js";
import { guessMime } from "./messages.js";

export const MAX_IMAGES = 8;

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".svg", ".ico", ".heic", ".heif", ".avif", ".tif", ".tiff",
]);

const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FILE_NAME_RE = /(?:file_?name|image_?file|image file|filename)\s*[:=]\s*["'`]?([A-Za-z0-9._\-\\\/% ]+?)["'`]?\s*(?:,|$|\n)/gi;
const GENERIC_PATH_RE = /(?:^|[\s"'`\[,=:])([A-Za-z0-9._\-\\\/ ]+\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?))(?:$|[\s"'`\],.:;])/gi;

export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
  }
  return "";
}

function decodeSafe(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function extractImageRefs(text) {
  const refs = [];
  const push = (value, kind) => {
    const v = decodeSafe(value.trim());
    if (!v) return;
    if (!refs.some((r) => r.value === v && r.kind === kind)) refs.push({ value: v, kind });
  };

  let m;
  const md = new RegExp(MD_IMAGE_RE.source, "g");
  while ((m = md.exec(text))) push(m[1], "markdown");

  const fn = new RegExp(FILE_NAME_RE.source, "ig");
  while ((m = fn.exec(text))) push(m[1], "file-name");

  const gp = new RegExp(GENERIC_PATH_RE.source, "gi");
  while ((m = gp.exec(text))) push(m[1], "path-token");

  return refs;
}

export function extractFilePartRefs(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const o = p;
    const type = typeof o.type === "string" ? o.type : "";
    if (type && type !== "file" && type !== "image" && type !== "image_file" && type !== "file_ref") continue;
    for (const key of ["path", "file_name", "fileName", "name", "url"]) {
      const v = o[key];
      if (typeof v === "string" && v.length > 0 && !v.startsWith("data:")) {
        out.push({
          value: decodeSafe(v.trim()),
          kind: "file-part",
          mimeType: typeof o.mime_type === "string" ? o.mime_type : typeof o.mimeType === "string" ? o.mimeType : undefined,
        });
        break;
      }
    }
  }
  return out;
}

function walkDir(root, maxDepth, maxFiles) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        out.push({ absPath: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore unreadable entries */
      }
    }
  };
  walk(root, 0);
  return out;
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

function isImageFile(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && IMAGE_EXT.has(path.extname(p).toLowerCase()) && st.size > 0 && st.size <= maxBytes;
  } catch {
    return false;
  }
}

export function resolveImages(workingDirectory, refs, opts) {
  if (refs.length === 0) return [];
  const isWin = process.platform === "win32";
  const norm = (p) => (isWin ? p.toLowerCase() : p);

  const files = walkDir(workingDirectory, 4, 20000);
  const imageFiles = [];
  for (const f of files) {
    if (IMAGE_EXT.has(path.extname(f.absPath).toLowerCase()) && f.sizeBytes > 0 && f.sizeBytes <= opts.maxImageBytes) {
      imageFiles.push(f);
    }
  }
  dbg("img", "scanned working directory", { files: files.length, imageFiles: imageFiles.length });

  const resolved = [];
  const used = new Set();

  const push = (absPath, matchedFrom, mimeHint) => {
    const ap = path.resolve(absPath);
    const key = norm(ap);
    if (used.has(key)) return;
    let meta = imageFiles.find((f) => norm(f.absPath) === key) ?? null;
    if (!meta) {
      try {
        const st = fs.statSync(ap);
        if (!st.isFile()) return;
        if (!IMAGE_EXT.has(path.extname(ap).toLowerCase())) {
          dbg("img", "candidate is not an image extension; skipping", { ap });
          return;
        }
        if (st.size <= 0 || st.size > opts.maxImageBytes) {
          warn("img", "candidate outside size limits; skipping", { ap, size: st.size, max: opts.maxImageBytes });
          return;
        }
        meta = { absPath: ap, sizeBytes: st.size, mtimeMs: st.mtimeMs };
      } catch {
        dbg("img", "candidate file does not exist; skipping", { ap });
        return;
      }
    }
    used.add(key);
    const im = {
      absPath: ap,
      relativePath: path.relative(workingDirectory, ap) || path.basename(ap),
      mimeType: mimeHint && mimeHint.startsWith("image/") ? mimeHint : guessMime(ap),
      sizeBytes: meta.sizeBytes,
      matchedFrom,
    };
    resolved.push(im);
    info("img", "image candidate adopted", { path: im.relativePath, matchedFrom, sizeBytes: meta.sizeBytes });
  };

  const relSlash = (p) => path.relative(workingDirectory, p).split(path.sep).join("/");

  const tryKind = (kind) => {
    const kindRefs = refs.filter((r) => r.kind === kind);
    let foundAny = false;
    for (const ref of kindRefs) {
      if (resolved.length >= MAX_IMAGES) break;
      const clean = ref.value.replace(/\\/g, "/");

      const exactCandidates = path.isAbsolute(ref.value) ? [ref.value] : [path.join(workingDirectory, ref.value)];
      const exact = exactCandidates.find((c) => isImageFile(c, opts.maxImageBytes));
      if (exact) {
        push(exact, `${kind}:exact`, ref.mimeType);
        foundAny = true;
        continue;
      }

      if (clean.includes("*")) {
        const re = globToRegExp(clean);
        const hits = imageFiles.filter((f) => re.test(relSlash(f.absPath)));
        hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (hits.length > 0) {
          push(hits[0].absPath, `${kind}:glob`, ref.mimeType);
          foundAny = true;
          continue;
        }
      }

      const base = path.basename(clean);
      const byBase = imageFiles.filter((f) => path.basename(f.absPath).toLowerCase() === base.toLowerCase());
      if (byBase.length > 0) {
        byBase.sort((a, b) => b.mtimeMs - a.mtimeMs);
        push(byBase[0].absPath, `${kind}:basename`, ref.mimeType);
        foundAny = true;
        continue;
      }

      // free-text path tokens may have swallowed preceding words
      // ("...see my shot.png"); retry with trailing suffixes, longest first
      if (kind === "path-token" && clean.includes(" ")) {
        const parts = clean.split(/\s+/).filter((p) => p.length > 0);
        let suffixHit = false;
        for (let start = parts.length - 1; start >= 1 && !suffixHit; start--) {
          const suffix = parts.slice(start).join(" ");
          const exactSuffix = path.join(workingDirectory, suffix);
          if (isImageFile(exactSuffix, opts.maxImageBytes)) {
            push(exactSuffix, `${kind}:suffix`, ref.mimeType);
            foundAny = true;
            suffixHit = true;
            continue;
          }
          const baseSuffix = path.basename(suffix);
          const hitsSuffix = imageFiles.filter((f) => path.basename(f.absPath).toLowerCase() === baseSuffix.toLowerCase());
          if (hitsSuffix.length > 0) {
            hitsSuffix.sort((a, b) => b.mtimeMs - a.mtimeMs);
            push(hitsSuffix[0].absPath, `${kind}:suffix`, ref.mimeType);
            foundAny = true;
            suffixHit = true;
          }
        }
        if (suffixHit) continue;
      }

      if (kind === "path-token") {
        const needle = norm(clean.replace(/^\.\//, ""));
        const sub = imageFiles.filter((f) => norm(relSlash(f.absPath)).includes(needle));
        if (sub.length > 0) {
          sub.sort((a, b) => b.mtimeMs - a.mtimeMs);
          push(sub[0].absPath, "path-token:substring", ref.mimeType);
          foundAny = true;
        }
      }

      dbg("img", "reference not resolved to a file", { value: ref.value, kind });
    }
    return foundAny;
  };

  if (!tryKind("markdown")) tryKind("file-name");
  if (!tryKind("file-part")) tryKind("path-token");
  return resolved.slice(0, MAX_IMAGES);
}

export function refsFromToolResult(msg) {
  const text = messageText(msg?.content);
  const fromText = extractImageRefs(text);
  const fromParts = extractFilePartRefs(msg?.content);
  const out = [...fromText];
  for (const r of fromParts) {
    if (!out.some((x) => x.value === r.value)) out.push(r);
  }
  return out;
}
