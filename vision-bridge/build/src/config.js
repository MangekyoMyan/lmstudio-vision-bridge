"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
/**
 * Runtime configuration.
 *
 * Priority: environment variables > <working directory>/.vision-bridge/config.json
 *          > ~/.vision-bridge/config.json > defaults.
 *
 * timeoutMs = 0 disables the absolute timeout. The optional GUI can still
 * abort the active request manually.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_SYNTHETIC_TEXT = "[Vision Bridge internal message]\n" +
    "This is not a new user request.\n" +
    "The attached image is the visual output returned by the immediately preceding MCP tool call.\n" +
    "Treat the attached image as part of that tool result.\n" +
    "Continue the existing user request using the visual information in this image.\n" +
    "Do not merely acknowledge, introduce, or describe the existence of the image.\n" +
    "Answer or continue the task that caused the tool to be called.";
function readJsonFile(p) {
    try {
        const raw = node_fs_1.default.readFileSync(p, "utf8");
        const v = JSON.parse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    }
    catch {
        return null;
    }
}
function toLevel(v) {
    const s = v.toLowerCase();
    return s === "debug" || s === "warn" || s === "error" ? s : "info";
}
function loadConfig(workingDirectory) {
    const fileCfg = {};
    // Merge LOW -> HIGH priority. The previous implementation accidentally
    // merged working-directory config first and the user config second, which
    // made ~/.vision-bridge/config.json override the project-local config even
    // though the documented priority said the opposite.
    const candidates = [
        node_path_1.default.join(node_os_1.default.homedir(), ".vision-bridge", "config.json"),
        workingDirectory ? node_path_1.default.join(workingDirectory, ".vision-bridge", "config.json") : null,
    ].filter((p) => typeof p === "string" && p.length > 0);
    for (const c of candidates) {
        const j = readJsonFile(c);
        if (j)
            Object.assign(fileCfg, j);
    }
    const getStr = (key, envName, fallback) => {
        const ev = process.env[envName];
        if (ev !== undefined && ev !== "")
            return ev;
        const fv = fileCfg[key];
        if (fv !== undefined && fv !== null && String(fv) !== "")
            return String(fv);
        return fallback;
    };
    const getPositiveNum = (key, envName, fallback) => {
        const raw = getStr(key, envName, String(fallback));
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const getNonNegativeNum = (key, envName, fallback) => {
        const raw = getStr(key, envName, String(fallback));
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const getBool = (key, envName, fallback) => {
        const raw = getStr(key, envName, String(fallback));
        return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
    };
    let logFile = getStr("logFile", "VISION_BRIDGE_LOG_FILE", "");
    if (!logFile) {
        const base = workingDirectory && workingDirectory.length > 0 ? workingDirectory : process.cwd();
        logFile = node_path_1.default.join(base, ".vision-bridge.log");
    }
    return {
        apiRoot: getStr("apiRoot", "VISION_BRIDGE_API_ROOT", "http://127.0.0.1:1238").replace(/\/+$/, ""),
        apiKey: getStr("apiKey", "VISION_BRIDGE_API_KEY", "lm-studio"),
        model: getStr("model", "VISION_BRIDGE_MODEL", "qwen/qwen3.8-27b"),
        // 0 = no absolute timeout. This avoids killing legitimate long reasoning
        // runs; the GUI/runtime telemetry makes the wait observable and abortable.
        timeoutMs: getNonNegativeNum("timeoutMs", "VISION_BRIDGE_TIMEOUT_MS", 0),
        maxImageBytes: getPositiveNum("maxImageBytes", "VISION_BRIDGE_MAX_IMAGE_BYTES", 20 * 1024 * 1024),
        logLevel: toLevel(getStr("logLevel", "VISION_BRIDGE_LOG_LEVEL", "info")),
        logFile,
        bridgeEnabled: getBool("bridgeEnabled", "VISION_BRIDGE_ENABLED", true),
        syntheticText: getStr("syntheticText", "VISION_BRIDGE_SYNTHETIC_TEXT", DEFAULT_SYNTHETIC_TEXT),
        requoteOriginalRequest: getBool("requoteOriginalRequest", "VISION_BRIDGE_REQUOTE_ORIGINAL_REQUEST", true),
    };
}
