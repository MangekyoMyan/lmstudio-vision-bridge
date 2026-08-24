"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appStateDirectory = appStateDirectory;
exports.runtimeStateFile = runtimeStateFile;
exports.controlStateFile = controlStateFile;
exports.beginRuntime = beginRuntime;
exports.patchRuntime = patchRuntime;
exports.startRuntimeHeartbeat = startRuntimeHeartbeat;
exports.startAbortWatcher = startAbortWatcher;
/**
 * Cross-process runtime telemetry/control for the optional local GUI.
 *
 * The LM Studio plugin and the GUI are separate Node processes, so they share
 * only tiny JSON files under ~/.vision-bridge/.  No chat text, image bytes, or
 * API keys are written here.  The runtime file is diagnostic-only; failures to
 * read/write it must never break generation.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const APP_DIR = node_path_1.default.join(node_os_1.default.homedir(), ".vision-bridge");
const RUNTIME_FILE = node_path_1.default.join(APP_DIR, "runtime.json");
const CONTROL_FILE = node_path_1.default.join(APP_DIR, "control.json");
function appStateDirectory() {
    return APP_DIR;
}
function runtimeStateFile() {
    return RUNTIME_FILE;
}
function controlStateFile() {
    return CONTROL_FILE;
}
function ensureDir() {
    node_fs_1.default.mkdirSync(APP_DIR, { recursive: true });
}
function atomicWriteJson(file, value) {
    ensureDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    node_fs_1.default.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    try {
        node_fs_1.default.renameSync(tmp, file);
    }
    catch {
        // Windows rename can fail when another process momentarily has the target
        // open. Fall back to a direct write; telemetry correctness is best-effort.
        try {
            node_fs_1.default.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
        }
        finally {
            try {
                node_fs_1.default.unlinkSync(tmp);
            }
            catch { /* ignore */ }
        }
    }
}
function readJson(file) {
    try {
        const parsed = JSON.parse(node_fs_1.default.readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function beginRuntime(initial) {
    const now = Date.now();
    const state = {
        version: 1,
        pid: process.pid,
        updatedAt: now,
        heartbeatAt: now,
        textChars: 0,
        reasoningChars: 0,
        reasoningEvents: 0,
        toolEvents: 0,
        ...initial,
    };
    try {
        atomicWriteJson(RUNTIME_FILE, state);
    }
    catch { /* diagnostics must not break generation */ }
    return state;
}
function patchRuntime(invocationId, patch) {
    try {
        const current = readJson(RUNTIME_FILE);
        // A newer invocation may have started while an older request is winding
        // down. Never allow the older request to overwrite the newer status.
        if (!current || current.invocationId !== invocationId)
            return;
        const next = {
            ...current,
            ...patch,
            invocationId,
            updatedAt: Date.now(),
        };
        atomicWriteJson(RUNTIME_FILE, next);
    }
    catch {
        /* diagnostics must not break generation */
    }
}
function startRuntimeHeartbeat(invocationId, intervalMs = 1000) {
    const timer = setInterval(() => {
        patchRuntime(invocationId, { heartbeatAt: Date.now() });
    }, Math.max(250, intervalMs));
    timer.unref?.();
    return () => clearInterval(timer);
}
/**
 * Poll the GUI control file for an abort request targeted at this invocation.
 * The returned disposer stops polling. The callback fires at most once.
 */
function startAbortWatcher(invocationId, onAbort, intervalMs = 500) {
    let fired = false;
    const poll = () => {
        if (fired)
            return;
        const control = readJson(CONTROL_FILE);
        if (control?.abortInvocationId !== invocationId)
            return;
        fired = true;
        try {
            node_fs_1.default.unlinkSync(CONTROL_FILE);
        }
        catch { /* GUI may rewrite it; harmless */ }
        onAbort();
    };
    poll();
    const timer = setInterval(poll, Math.max(200, intervalMs));
    timer.unref?.();
    return () => clearInterval(timer);
}
