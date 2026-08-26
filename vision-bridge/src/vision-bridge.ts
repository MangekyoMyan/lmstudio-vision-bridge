/**
 * Vision Bridge orchestration.
 *
 * LM Studio Generator mode:
 *   - converts LM Studio history to OpenAI-compatible messages (copy)
 *   - detects image references in tool results and injects one synthetic user
 *     vision message after the latest tool result.
 *
 * OpenAI proxy mode:
 *   - performs the same image detection/injection, but preserves the client's
 *     already-OpenAI-compatible messages byte-for-byte at the object level
 *     (except for inserting the synthetic message). This avoids accidentally
 *     stripping vendor/client-specific message fields while sitting between
 *     Open WebUI and an upstream model server.
 */
import { dbg, info, warn } from "./log.js";
import { fileToDataUrl, toOpenAIMessage } from "./messages.js";
import { refsFromToolResult, resolveImages, type ImageRef, type ResolvedImage } from "./image-detect.js";
import type { SeenTracker } from "./dedup.js";
import { getWorkingDirectory } from "./controller.js";
import type { Config } from "./config.js";
import type { AnyMessage, OpenAIChatMessage, OpenAIPart } from "./types.js";

export interface InjectedImageInfo {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  dataUrlChars: number;
  matchedFrom: string;
  toolCallId?: string;
}

export interface BridgeOutput {
  messages: OpenAIChatMessage[];
  injected: InjectedImageInfo[];
  skippedDuplicates: number;
  workingDirectory: string | null;
}

export interface OpenAIProxyBridgeOutput {
  messages: unknown[];
  injected: InjectedImageInfo[];
  skippedDuplicates: number;
  workingDirectory: string | null;
}

interface MaterializedImage {
  image: ResolvedImage;
  dataUrl: string;
  toolCallId?: string;
}

/** Safely extract the plain text of a message (string / array / object content). Never throws. */
function messageTextOf(m: AnyMessage): string | null {
  const content = (m ?? ({} as AnyMessage)).content;
  if (typeof content === "string") {
    const t = content.trim();
    return t.length > 0 ? t : null;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        if (p.trim().length > 0) texts.push(p.trim());
        continue;
      }
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        if (typeof o.text === "string" && o.text.trim().length > 0) {
          texts.push(o.text.trim());
        } else if (typeof o.content === "string" && o.content.trim().length > 0) {
          texts.push(o.content.trim());
        }
      }
    }
    const joined = texts.join("\n");
    return joined.length > 0 ? joined : null;
  }
  if (content && typeof content === "object") {
    const t = (content as Record<string, unknown>).text;
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  return null;
}

/** Find the user request that caused the most recent tool call. */
function findOriginalPendingRequest(messages: AnyMessage[]): string | null {
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && m.role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
  const limit = lastToolIdx >= 0 ? lastToolIdx : messages.length;
  for (let i = limit - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || m.role !== "user") continue;
    const t = messageTextOf(m);
    if (t) return t;
  }
  return null;
}

function makeSyntheticText(messages: AnyMessage[], cfg: Config): string {
  let text = cfg.syntheticText;
  if (!cfg.requoteOriginalRequest) return text;
  const original = findOriginalPendingRequest(messages);
  if (!original) return text;
  text = [
    "[Vision Bridge internal message]",
    "This is not a new user request.",
    "The attached image is the visual output returned by the immediately preceding MCP tool call.",
    "Treat the image as part of that tool result and continue the existing task.",
    "Original pending user request:",
    JSON.stringify(original),
    "Do not merely acknowledge or introduce the image.",
    "Use the image to continue and answer the original request.",
  ].join("\n");
  info("bridge", "synthetic message re-quotes the original pending user request", { chars: original.length });
  return text;
}

function toolMessageIndices(messages: AnyMessage[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m && typeof m === "object" && m.role === "tool") out.push(i);
  });
  return out;
}

function toolCallIdFor(messages: AnyMessage[], toolIndices: number[], image: ResolvedImage): string | undefined {
  const base = image.relativePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  for (const i of toolIndices) {
    const refs = refsFromToolResult(messages[i]);
    if (refs.some((r) => r.value.split(/[\\/]/).pop()?.toLowerCase() === base)) {
      const m = messages[i];
      const id = m?.tool_call_id ?? m?.toolCallId;
      return typeof id === "string" ? id : undefined;
    }
  }
  const last = toolIndices[toolIndices.length - 1];
  const m = messages[last];
  const id = m?.tool_call_id ?? m?.toolCallId;
  return typeof id === "string" ? id : undefined;
}

function materializeImages(opts: {
  messages: AnyMessage[];
  cfg: Config;
  seen: SeenTracker;
  baseDir: string;
}): { materialized: MaterializedImage[]; skipped: number; toolIndices: number[] } {
  const toolIndices = toolMessageIndices(opts.messages);
  if (toolIndices.length === 0) {
    dbg("bridge", "no tool-result messages in history; nothing to do");
    return { materialized: [], skipped: 0, toolIndices };
  }

  const allRefs: ImageRef[] = [];
  for (const i of toolIndices) {
    const refs = refsFromToolResult(opts.messages[i]);
    if (refs.length > 0) {
      allRefs.push(...refs);
      info("bridge", "image reference(s) detected in tool result", {
        at: i,
        count: refs.length,
        values: refs.map((r) => r.value),
        kinds: refs.map((r) => r.kind),
      });
    }
  }

  if (allRefs.length === 0) {
    dbg("bridge", `tool results present (${toolIndices.length}) but no image references found; sending history unchanged`);
    return { materialized: [], skipped: 0, toolIndices };
  }

  const resolved = resolveImages(opts.baseDir, allRefs, { maxImageBytes: opts.cfg.maxImageBytes });
  if (resolved.length === 0) {
    warn("bridge", "image references exist but no matching image file was found", {
      workingDirectory: opts.baseDir,
      refs: allRefs.slice(0, 10).map((r) => r.value),
    });
    return { materialized: [], skipped: 0, toolIndices };
  }
  info("bridge", "image candidate(s) resolved", resolved.map((im) => ({
    path: im.relativePath,
    matchedFrom: im.matchedFrom,
    sizeBytes: im.sizeBytes,
  })));

  const materialized: MaterializedImage[] = [];
  let skipped = 0;
  for (const image of resolved) {
    let dataUrl: string;
    try {
      dataUrl = fileToDataUrl(image.absPath, image.mimeType);
    } catch (e) {
      warn("bridge", `failed to encode image as data URL: ${image.relativePath}`, String(e));
      skipped++;
      continue;
    }
    const tci = toolCallIdFor(opts.messages, toolIndices, image);
    const reg = opts.seen.registerIfNew(image, tci);
    if (!reg.injected) {
      skipped++;
      continue;
    }
    materialized.push({ image, dataUrl, toolCallId: tci });
  }

  return { materialized, skipped, toolIndices };
}

function injectionParts(messages: AnyMessage[], cfg: Config, materialized: MaterializedImage[]): OpenAIPart[] {
  const parts: OpenAIPart[] = [{ type: "text", text: makeSyntheticText(messages, cfg) }];
  for (const m of materialized) parts.push({ type: "image_url", image_url: { url: m.dataUrl } });
  return parts;
}

function injectedInfo(materialized: MaterializedImage[]): InjectedImageInfo[] {
  return materialized.map((m) => ({
    relativePath: m.image.relativePath,
    mimeType: m.image.mimeType,
    sizeBytes: m.image.sizeBytes,
    dataUrlChars: m.dataUrl.length,
    matchedFrom: m.image.matchedFrom,
    toolCallId: m.toolCallId,
  }));
}

/** Existing LM Studio Generator path. */
export function applyVisionBridge(opts: {
  ctl: unknown;
  messages: AnyMessage[];
  cfg: Config;
  seen: SeenTracker;
  /** Optional override used by tests/adapters; omitted keeps existing controller behavior. */
  workingDirectory?: string | null;
}): BridgeOutput {
  const wd = opts.workingDirectory !== undefined
    ? opts.workingDirectory
    : getWorkingDirectory(opts.ctl as Record<string, unknown>) ?? null;
  const baseDir = wd ?? process.cwd();
  const base = opts.messages.map((m, i) => toOpenAIMessage(m, i, baseDir));

  if (!opts.cfg.bridgeEnabled) {
    dbg("bridge", "bridge disabled via config; sending history unchanged");
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
  }

  const { materialized, skipped, toolIndices } = materializeImages({
    messages: opts.messages,
    cfg: opts.cfg,
    seen: opts.seen,
    baseDir,
  });
  if (materialized.length === 0) {
    if (skipped > 0) info("bridge", "all candidate images were duplicates or unreadable; sending history unchanged", { skipped });
    return { messages: base, injected: [], skippedDuplicates: skipped, workingDirectory: wd };
  }

  const synthetic: OpenAIChatMessage = { role: "user", content: injectionParts(opts.messages, opts.cfg, materialized) };
  const lastToolIdx = toolIndices.length > 0 ? toolIndices[toolIndices.length - 1] : -1;
  const insertAt = lastToolIdx >= 0 ? lastToolIdx + 1 : base.length;
  const out = base.slice(0, insertAt).concat(synthetic, base.slice(insertAt));

  info("bridge", "VISION MESSAGE INJECTED (internal copy only — LM Studio history untouched)", {
    insertedAt: insertAt,
    images: materialized.map((m) => m.image.relativePath),
    totalDataUrlChars: materialized.reduce((s, m) => s + m.dataUrl.length, 0),
    skippedDuplicates: skipped,
  });

  return {
    messages: out,
    injected: injectedInfo(materialized),
    skippedDuplicates: skipped,
    workingDirectory: wd,
  };
}

/**
 * OpenAI-compatible proxy path. Existing client messages are preserved exactly;
 * only a new synthetic user vision message is inserted when an MCP/tool image
 * can be resolved. This is deliberately separate from the LM Studio adapter.
 */
export function applyVisionBridgeToOpenAI(opts: {
  messages: unknown[];
  cfg: Config;
  seen: SeenTracker;
  workingDirectory?: string | null;
}): OpenAIProxyBridgeOutput {
  const messages = opts.messages.filter((m): m is AnyMessage => !!m && typeof m === "object" && !Array.isArray(m));
  const wd = opts.workingDirectory && opts.workingDirectory.trim().length > 0 ? opts.workingDirectory : null;
  const baseDir = wd ?? process.cwd();
  // Array copy only. We never mutate the existing message objects.
  const base: unknown[] = opts.messages.slice();

  if (!opts.cfg.bridgeEnabled) {
    dbg("bridge", "bridge disabled via config; proxy request forwarded unchanged");
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
  }

  const { materialized, skipped, toolIndices } = materializeImages({
    messages,
    cfg: opts.cfg,
    seen: opts.seen,
    baseDir,
  });
  if (materialized.length === 0) {
    return { messages: base, injected: [], skippedDuplicates: skipped, workingDirectory: wd };
  }

  // toolIndices are based on the filtered object-message list. Normal OpenAI
  // requests consist only of object messages, so this is also the wire index.
  // If malformed non-object entries exist, fall back to finding the last tool
  // in the original array to avoid inserting at the wrong place.
  let insertAt = -1;
  for (let i = base.length - 1; i >= 0; i--) {
    const m = base[i];
    if (m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>).role === "tool") {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt < 0) insertAt = base.length;

  const synthetic = { role: "user", content: injectionParts(messages, opts.cfg, materialized) };
  const out = base.slice(0, insertAt).concat(synthetic, base.slice(insertAt));

  info("bridge", "VISION MESSAGE INJECTED (OpenAI proxy request copy)", {
    insertedAt: insertAt,
    images: materialized.map((m) => m.image.relativePath),
    totalDataUrlChars: materialized.reduce((s, m) => s + m.dataUrl.length, 0),
    skippedDuplicates: skipped,
  });

  return {
    messages: out,
    injected: injectedInfo(materialized),
    skippedDuplicates: skipped,
    workingDirectory: wd,
  };
}
