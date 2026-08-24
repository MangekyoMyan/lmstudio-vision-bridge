"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeenTracker = void 0;
/**
 * Dedup: remember which image CONTENTS were already injected into vision,
 * so the same image is not sent to the model again on later rounds.
 *
 * - primary key: SHA-256 of the file content
 *   (same path with NEW content => injected again; identical content => skipped)
 * - state persisted to <working directory>/.vision-bridge/state.json so it
 *   survives generator re-instantiation within the same prediction
 * - tool call id recorded for traceability
 */
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const log_js_1 = require("./log.js");
const STATE_DIRNAME = ".vision-bridge";
const STATE_FILE = "state.json";
const MAX_ENTRIES = 2000;
class SeenTracker {
    byHash = new Map();
    stateFile;
    constructor(workingDirectory) {
        this.stateFile = workingDirectory ? node_path_1.default.join(workingDirectory, STATE_DIRNAME, STATE_FILE) : null;
        this.load();
    }
    load() {
        if (!this.stateFile)
            return;
        try {
            const raw = node_fs_1.default.readFileSync(this.stateFile, "utf8");
            const json = JSON.parse(raw);
            if (Array.isArray(json.seen)) {
                for (const r of json.seen) {
                    if (r && typeof r.hash === "string")
                        this.byHash.set(r.hash, r);
                }
                if (this.byHash.size > 0) {
                    (0, log_js_1.dbg)("dedup", `restored ${this.byHash.size} seen image(s) from state file`, this.stateFile);
                }
            }
        }
        catch {
            (0, log_js_1.dbg)("dedup", "no previous state file; starting fresh");
        }
    }
    persist() {
        if (!this.stateFile)
            return;
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.stateFile), { recursive: true });
            const entries = Array.from(this.byHash.values()).slice(-MAX_ENTRIES);
            node_fs_1.default.writeFileSync(this.stateFile, JSON.stringify({ seen: entries, updatedAt: Date.now() }, null, 2));
        }
        catch (e) {
            (0, log_js_1.dbg)("dedup", "failed to persist state file", String(e));
        }
    }
    contentHash(image) {
        // Always hash the current file bytes. The previous cache keyed only on
        // path+size, so an overwritten screenshot with different pixels but the
        // exact same byte length could be mistaken for the old image forever.
        // With max 8 images / 20 MB each, correctness is worth the tiny I/O cost.
        const buf = node_fs_1.default.readFileSync(image.absPath);
        return node_crypto_1.default.createHash("sha256").update(buf).digest("hex");
    }
    isSeen(hash) {
        return this.byHash.has(hash);
    }
    registerIfNew(image, toolCallId) {
        let hash;
        try {
            hash = this.contentHash(image);
        }
        catch (e) {
            (0, log_js_1.warn)("dedup", `hash failed for ${image.relativePath}; using path-based key`, String(e));
            hash = `path:${image.relativePath}`;
        }
        const existing = this.byHash.get(hash);
        if (existing) {
            (0, log_js_1.dbg)("dedup", "DUPLICATE image skipped (already injected into a previous round)", {
                path: image.relativePath,
                hash: hash.slice(0, 16),
                secondsAgo: Math.round((Date.now() - existing.firstSeenAt) / 1000),
                toolCallId: existing.firstToolCallId ?? null,
            });
            return { injected: false, hash, reason: "duplicate" };
        }
        this.byHash.set(hash, {
            hash,
            relativePath: image.relativePath,
            firstToolCallId: toolCallId,
            firstSeenAt: Date.now(),
        });
        this.persist();
        (0, log_js_1.dbg)("dedup", "image registered as injected", { path: image.relativePath, hash: hash.slice(0, 16) });
        return { injected: true, hash };
    }
    get size() {
        return this.byHash.size;
    }
}
exports.SeenTracker = SeenTracker;
