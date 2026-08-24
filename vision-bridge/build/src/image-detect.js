"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_IMAGES = void 0;
exports.messageText = messageText;
exports.extractImageRefs = extractImageRefs;
exports.extractFilePartRefs = extractFilePartRefs;
exports.resolveImages = resolveImages;
exports.refsFromToolResult = refsFromToolResult;
/**
 * Phase 2: MCP image detection.
 *
 * Given the updated chat history, find image references inside `tool` result
 * messages and map them onto concrete image files in the working directory.
 *
 * Deliberately NOT "pick the newest file in the folder": we match the
 * references that the tool result actually contains:
 *   1. markdown image refs      ![...](path)
 *   2. "fileName: xxx" style    (LM Studio's saved-image tool results)
 *   3. image-extension tokens   (last-resort fallback)
 * plus file parts embedded in the tool result content array.
 *
 * Resolution priority per reference: exact path -> glob -> basename ->
 * substring. Multiple matches on the same name: newest mtime wins.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const log_js_1 = require("./log.js");
const messages_js_1 = require("./messages.js");
exports.MAX_IMAGES = 8;
const IMAGE_EXT = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".svg", ".ico", ".heic", ".heif", ".avif", ".tif", ".tiff",
]);
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FILE_NAME_RE = /(?:file_?name|image_?file|image file|filename)\s*[:=]\s*["'`]?([A-Za-z0-9._\-\\\/% ]+?)["'`]?\s*(?:,|$|\n)/gi;
const GENERIC_PATH_RE = /(?:^|[\s"'`\[,=:])([A-Za-z0-9._\-\\\/ ]+\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?))(?:$|[\s"'`\],.:;])/gi;
function messageText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => {
            if (typeof p === "string")
                return p;
            if (p && typeof p === "object") {
                const o = p;
                if (typeof o.text === "string")
                    return o.text;
                if (typeof o.content === "string")
                    return o.content;
            }
            return "";
        })
            .join("\n");
    }
    if (content && typeof content === "object") {
        const o = content;
        if (typeof o.text === "string")
            return o.text;
    }
    return "";
}
function decodeSafe(v) {
    try {
        return decodeURIComponent(v);
    }
    catch {
        return v;
    }
}
/** Extract image references from a tool-result text payload. */
function extractImageRefs(text) {
    const refs = [];
    const push = (value, kind) => {
        const v = decodeSafe(value.trim());
        if (!v)
            return;
        if (!refs.some((r) => r.value === v && r.kind === kind))
            refs.push({ value: v, kind });
    };
    let m;
    const md = new RegExp(MD_IMAGE_RE.source, "g");
    while ((m = md.exec(text)))
        push(m[1], "markdown");
    const fn = new RegExp(FILE_NAME_RE.source, "ig");
    while ((m = fn.exec(text)))
        push(m[1], "file-name");
    const gp = new RegExp(GENERIC_PATH_RE.source, "gi");
    while ((m = gp.exec(text)))
        push(m[1], "path-token");
    return refs;
}
/** Extract image references from file parts inside a tool-result content array. */
function extractFilePartRefs(content) {
    if (!Array.isArray(content))
        return [];
    const out = [];
    for (const p of content) {
        if (!p || typeof p !== "object")
            continue;
        const o = p;
        const type = typeof o.type === "string" ? o.type : "";
        if (type && type !== "file" && type !== "image" && type !== "image_file" && type !== "file_ref")
            continue;
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
        if (depth > maxDepth || out.length >= maxFiles)
            return;
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= maxFiles)
                break;
            if (e.isSymbolicLink())
                continue;
            const full = node_path_1.default.join(dir, e.name);
            if (e.isDirectory()) {
                if (!e.name.startsWith(".") && e.name !== "node_modules")
                    walk(full, depth + 1);
                continue;
            }
            if (!e.isFile())
                continue;
            try {
                const st = node_fs_1.default.statSync(full);
                out.push({ absPath: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
            }
            catch {
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
        }
        else if (c === "*") {
            out += "[^/]*";
        }
        else if (c === "?") {
            out += "[^/]";
        }
        else {
            out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(out + "$");
}
function isImageFile(p, maxBytes) {
    try {
        const st = node_fs_1.default.statSync(p);
        return st.isFile() && IMAGE_EXT.has(node_path_1.default.extname(p).toLowerCase()) && st.size > 0 && st.size <= maxBytes;
    }
    catch {
        return false;
    }
}
/**
 * Resolve references onto concrete image files.
 * Returns 0..MAX_IMAGES resolved images (deduplicated by absolute path).
 */
function resolveImages(workingDirectory, refs, opts) {
    if (refs.length === 0)
        return [];
    const isWin = process.platform === "win32";
    const norm = (p) => (isWin ? p.toLowerCase() : p);
    const files = walkDir(workingDirectory, 4, 20000);
    const imageFiles = [];
    for (const f of files) {
        if (IMAGE_EXT.has(node_path_1.default.extname(f.absPath).toLowerCase()) && f.sizeBytes > 0 && f.sizeBytes <= opts.maxImageBytes) {
            imageFiles.push(f);
        }
    }
    (0, log_js_1.dbg)("img", "scanned working directory", { files: files.length, imageFiles: imageFiles.length });
    const resolved = [];
    const used = new Set();
    const push = (absPath, matchedFrom, mimeHint) => {
        const ap = node_path_1.default.resolve(absPath);
        const key = norm(ap);
        if (used.has(key))
            return;
        let meta = imageFiles.find((f) => norm(f.absPath) === key) ?? null;
        if (!meta) {
            // reference may point outside the working directory (absolute path)
            try {
                const st = node_fs_1.default.statSync(ap);
                if (!st.isFile())
                    return;
                if (!IMAGE_EXT.has(node_path_1.default.extname(ap).toLowerCase())) {
                    (0, log_js_1.dbg)("img", "candidate is not an image extension; skipping", { ap });
                    return;
                }
                if (st.size <= 0 || st.size > opts.maxImageBytes) {
                    (0, log_js_1.warn)("img", "candidate outside size limits; skipping", { ap, size: st.size, max: opts.maxImageBytes });
                    return;
                }
                meta = { absPath: ap, sizeBytes: st.size, mtimeMs: st.mtimeMs };
            }
            catch {
                (0, log_js_1.dbg)("img", "candidate file does not exist; skipping", { ap });
                return;
            }
        }
        used.add(key);
        const im = {
            absPath: ap,
            relativePath: node_path_1.default.relative(workingDirectory, ap) || node_path_1.default.basename(ap),
            mimeType: mimeHint && mimeHint.startsWith("image/") ? mimeHint : (0, messages_js_1.guessMime)(ap),
            sizeBytes: meta.sizeBytes,
            matchedFrom,
        };
        resolved.push(im);
        (0, log_js_1.info)("img", "image candidate adopted", { path: im.relativePath, matchedFrom, sizeBytes: meta.sizeBytes });
    };
    const relSlash = (p) => node_path_1.default.relative(workingDirectory, p).split(node_path_1.default.sep).join("/");
    const tryKind = (kind) => {
        const kindRefs = refs.filter((r) => r.kind === kind);
        let foundAny = false;
        for (const ref of kindRefs) {
            if (resolved.length >= exports.MAX_IMAGES)
                break;
            const clean = ref.value.replace(/\\/g, "/");
            // (a) exact path (relative to working dir, or absolute)
            const exactCandidates = node_path_1.default.isAbsolute(ref.value)
                ? [ref.value]
                : [node_path_1.default.join(workingDirectory, ref.value)];
            const exact = exactCandidates.find((c) => isImageFile(c, opts.maxImageBytes));
            if (exact) {
                push(exact, `${kind}:exact`, ref.mimeType);
                foundAny = true;
                continue;
            }
            // (b) glob patterns
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
            // (c) basename match (newest first)
            const base = node_path_1.default.basename(clean);
            const byBase = imageFiles.filter((f) => node_path_1.default.basename(f.absPath).toLowerCase() === base.toLowerCase());
            if (byBase.length > 0) {
                byBase.sort((a, b) => b.mtimeMs - a.mtimeMs);
                push(byBase[0].absPath, `${kind}:basename`, ref.mimeType);
                foundAny = true;
                continue;
            }
            // (d) free-text path tokens may have swallowed preceding words
            //     ("...see my shot.png"); retry with trailing suffixes, longest first
            if (kind === "path-token" && clean.includes(" ")) {
                const parts = clean.split(/\s+/).filter((p) => p.length > 0);
                let suffixHit = false;
                for (let start = parts.length - 1; start >= 1 && !suffixHit; start--) {
                    const suffix = parts.slice(start).join(" ");
                    const exactSuffix = node_path_1.default.join(workingDirectory, suffix);
                    if (isImageFile(exactSuffix, opts.maxImageBytes)) {
                        push(exactSuffix, `${kind}:suffix`, ref.mimeType);
                        foundAny = true;
                        suffixHit = true;
                        continue;
                    }
                    const baseSuffix = node_path_1.default.basename(suffix);
                    const hitsSuffix = imageFiles.filter((f) => node_path_1.default.basename(f.absPath).toLowerCase() === baseSuffix.toLowerCase());
                    if (hitsSuffix.length > 0) {
                        hitsSuffix.sort((a, b) => b.mtimeMs - a.mtimeMs);
                        push(hitsSuffix[0].absPath, `${kind}:suffix`, ref.mimeType);
                        foundAny = true;
                        suffixHit = true;
                    }
                }
                if (suffixHit)
                    continue;
            }
            // (e) substring of the relative path (last-resort fallback kind only)
            if (kind === "path-token") {
                const needle = norm(clean.replace(/^\.\//, ""));
                const sub = imageFiles.filter((f) => norm(relSlash(f.absPath)).includes(needle));
                if (sub.length > 0) {
                    sub.sort((a, b) => b.mtimeMs - a.mtimeMs);
                    push(sub[0].absPath, "path-token:substring", ref.mimeType);
                    foundAny = true;
                }
            }
            (0, log_js_1.dbg)("img", "reference not resolved to a file", { value: ref.value, kind });
        }
        return foundAny;
    };
    if (!tryKind("markdown"))
        tryKind("file-name");
    if (!tryKind("file-part"))
        tryKind("path-token");
    return resolved.slice(0, exports.MAX_IMAGES);
}
/** Convenience: collect all refs from a single tool-result message. */
function refsFromToolResult(msg) {
    const text = messageText(msg?.content);
    const fromText = extractImageRefs(text);
    const fromParts = extractFilePartRefs(msg?.content);
    const out = [...fromText];
    for (const r of fromParts) {
        if (!out.some((x) => x.value === r.value))
            out.push(r);
    }
    return out;
}
