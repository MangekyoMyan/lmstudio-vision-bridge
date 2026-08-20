/**
 * Dedup by image content hash (prebuilt mirror of src/dedup.ts).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbg, warn } from "./log.js";

const STATE_DIRNAME = ".vision-bridge";
const STATE_FILE = "state.json";
const MAX_ENTRIES = 2000;

export class SeenTracker {
  constructor(workingDirectory) {
    this.byHash = new Map();
    this.hashCache = new Map();
    this.stateFile = workingDirectory ? path.join(workingDirectory, STATE_DIRNAME, STATE_FILE) : null;
    this.load();
  }

  load() {
    if (!this.stateFile) return;
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const json = JSON.parse(raw);
      if (Array.isArray(json.seen)) {
        for (const r of json.seen) {
          if (r && typeof r.hash === "string") this.byHash.set(r.hash, r);
        }
        if (this.byHash.size > 0) {
          dbg("dedup", `restored ${this.byHash.size} seen image(s) from state file`, this.stateFile);
        }
      }
    } catch {
      dbg("dedup", "no previous state file; starting fresh");
    }
  }

  persist() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const entries = Array.from(this.byHash.values()).slice(-MAX_ENTRIES);
      fs.writeFileSync(this.stateFile, JSON.stringify({ seen: entries, updatedAt: Date.now() }, null, 2));
    } catch (e) {
      dbg("dedup", "failed to persist state file", String(e));
    }
  }

  contentHash(image) {
    const cacheKey = `${image.absPath}|${image.sizeBytes}`;
    const cached = this.hashCache.get(cacheKey);
    if (cached) return cached;
    const buf = fs.readFileSync(image.absPath);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    this.hashCache.set(cacheKey, hash);
    if (this.hashCache.size > 200) {
      const first = this.hashCache.keys().next().value;
      if (first) this.hashCache.delete(first);
    }
    return hash;
  }

  isSeen(hash) {
    return this.byHash.has(hash);
  }

  registerIfNew(image, toolCallId) {
    let hash;
    try {
      hash = this.contentHash(image);
    } catch (e) {
      warn("dedup", `hash failed for ${image.relativePath}; using path-based key`, String(e));
      hash = `path:${image.relativePath}`;
    }

    const existing = this.byHash.get(hash);
    if (existing) {
      dbg("dedup", "DUPLICATE image skipped (already injected into a previous round)", {
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
    dbg("dedup", "image registered as injected", { path: image.relativePath, hash: hash.slice(0, 16) });
    return { injected: true, hash };
  }

  get size() {
    return this.byHash.size;
  }
}
