"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.err = exports.warn = exports.info = exports.dbg = void 0;
exports.configure = configure;
exports.log = log;
/**
 * Small leveled logger. Writes to the host console AND an append-mode log
 * file. Long strings (especially base64 blobs) are redacted — never log the
 * full image payload.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const RANK = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = RANK.info;
let fileStream = null;
let fileConfiguredFor = null;
// base64-looking runs of 160+ chars (a real image will be far longer)
const B64_RE = /[A-Za-z0-9+/]{160,}={0,2}/g;
function configure(level, logFile) {
    threshold = RANK[level] ?? RANK.info;
    if (logFile && logFile !== fileConfiguredFor) {
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(logFile), { recursive: true });
            fileStream?.close();
            fileStream = node_fs_1.default.createWriteStream(logFile, { flags: "a" });
            fileConfiguredFor = logFile;
        }
        catch {
            fileStream = null;
        }
    }
}
function redact(s) {
    return s.replace(B64_RE, (m) => `<redacted-b64:${m.length}b>`).slice(0, 4000);
}
function serialize(extra) {
    try {
        const json = JSON.stringify(extra, (_k, v) => typeof v === "string" && v.length > 800 ? `<string:${v.length} chars>` : v);
        return redact(json ?? String(extra));
    }
    catch {
        return redact(String(extra));
    }
}
function log(level, scope, message, extra) {
    if (RANK[level] < threshold)
        return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}` +
        (extra !== undefined ? ` ${serialize(extra)}` : "");
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(line);
    if (fileStream)
        fileStream.write(line + "\n");
}
const dbg = (scope, message, extra) => log("debug", scope, message, extra);
exports.dbg = dbg;
const info = (scope, message, extra) => log("info", scope, message, extra);
exports.info = info;
const warn = (scope, message, extra) => log("warn", scope, message, extra);
exports.warn = warn;
const err = (scope, message, extra) => log("error", scope, message, extra);
exports.err = err;
