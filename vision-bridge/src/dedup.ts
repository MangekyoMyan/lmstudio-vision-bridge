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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbg, warn } from "./log.js";
import type { ResolvedImage } from "./image-detect.js";

const STATE_DIRNAME = ".vision-bridge";
const STATE_FILE = "state.json";
const MAX_ENTRIES = 2000;

interface SeenRecord {
  hash: string;
  relativePath: string;
  firstToolCallId?: string;
  firstSeenAt: number;
}

export class SeenTracker {
  private byHash = new Map<string, SeenRecord>();
  private stateFile: string | null;

  constructor(workingDirectory: string | null) {
    this.stateFile = workingDirectory ? path.join(workingDirectory, STATE_DIRNAME, STATE_FILE) : null;
    this.load();
  }

  private load(): void {
    if (!this.stateFile) return;
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const json = JSON.parse(raw) as { seen?: SeenRecord[] };
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

  private persist(): void {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const entries = Array.from(this.byHash.values()).slice(-MAX_ENTRIES);
      fs.writeFileSync(this.stateFile, JSON.stringify({ seen: entries, updatedAt: Date.now() }, null, 2));
    } catch (e) {
      dbg("dedup", "failed to persist state file", String(e));
    }
  }

  contentHash(image: ResolvedImage): string {
    // Always hash the current file bytes. The previous cache keyed only on
    // path+size, so an overwritten screenshot with different pixels but the
    // exact same byte length could be mistaken for the old image forever.
    // With max 8 images / 20 MB each, correctness is worth the tiny I/O cost.
    const buf = fs.readFileSync(image.absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  isSeen(hash: string): boolean {
    return this.byHash.has(hash);
  }

  registerIfNew(
    image: ResolvedImage,
    toolCallId?: string
  ): { injected: true; hash: string } | { injected: false; hash: string; reason: string } {
    let hash: string;
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

  get size(): number {
    return this.byHash.size;
  }
}
