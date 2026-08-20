/**
 * Small leveled logger. Writes to the host console AND an append-mode log
 * file. Long strings (especially base64 blobs) are redacted — never log the
 * full image payload.
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;
let fileStream: fs.WriteStream | null = null;
let fileConfiguredFor: string | null = null;

// base64-looking runs of 160+ chars (a real image will be far longer)
const B64_RE = /[A-Za-z0-9+/]{160,}={0,2}/g;

export function configure(level: LogLevel, logFile?: string): void {
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

function redact(s: string): string {
  return s.replace(B64_RE, (m) => `<redacted-b64:${m.length}b>`).slice(0, 4000);
}

function serialize(extra: unknown): string {
  try {
    const json = JSON.stringify(extra, (_k, v: unknown) =>
      typeof v === "string" && v.length > 800 ? `<string:${v.length} chars>` : v
    );
    return redact(json ?? String(extra));
  } catch {
    return redact(String(extra));
  }
}

export function log(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (RANK[level] < threshold) return;
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}` +
    (extra !== undefined ? ` ${serialize(extra)}` : "");
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(line);
  if (fileStream) fileStream.write(line + "\n");
}

export const dbg = (scope: string, message: string, extra?: unknown): void => log("debug", scope, message, extra);
export const info = (scope: string, message: string, extra?: unknown): void => log("info", scope, message, extra);
export const warn = (scope: string, message: string, extra?: unknown): void => log("warn", scope, message, extra);
export const err = (scope: string, message: string, extra?: unknown): void => log("error", scope, message, extra);
