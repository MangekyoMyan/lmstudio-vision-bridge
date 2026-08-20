/**
 * Small leveled logger (prebuilt mirror of src/log.ts).
 * Long strings (especially base64 blobs) are redacted — never log the
 * full image payload.
 */
import fs from "node:fs";
import path from "node:path";

const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;
let fileStream = null;
let fileConfiguredFor = null;

const B64_RE = /[A-Za-z0-9+/]{160,}={0,2}/g;

export function configure(level, logFile) {
  threshold = RANK[level] ?? RANK.info;
  if (logFile && logFile !== fileConfiguredFor) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fileStream?.close();
      fileStream = fs.createWriteStream(logFile, { flags: "a" });
      fileConfiguredFor = logFile;
    } catch {
      fileStream = null;
    }
  }
}

function redact(s) {
  return s.replace(B64_RE, (m) => `<redacted-b64:${m.length}b>`).slice(0, 4000);
}

function serialize(extra) {
  try {
    const json = JSON.stringify(extra, (_k, v) =>
      typeof v === "string" && v.length > 800 ? `<string:${v.length} chars>` : v
    );
    return redact(json ?? String(extra));
  } catch {
    return redact(String(extra));
  }
}

export function log(level, scope, message, extra) {
  if (RANK[level] < threshold) return;
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}` +
    (extra !== undefined ? ` ${serialize(extra)}` : "");
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(line);
  if (fileStream) fileStream.write(line + "\n");
}

export const dbg = (scope, message, extra) => log("debug", scope, message, extra);
export const info = (scope, message, extra) => log("info", scope, message, extra);
export const warn = (scope, message, extra) => log("warn", scope, message, extra);
export const err = (scope, message, extra) => log("error", scope, message, extra);
