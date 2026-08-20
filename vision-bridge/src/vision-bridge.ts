/**
 * Phase 3: Vision Bridge orchestration.
 *
 * - converts the LM Studio history to OpenAI-compatible messages (copy!)
 * - detects image references in tool-result messages (Phase 2)
 * - resolves them to files in the working directory
 * - dedups by content hash (SeenTracker)
 * - if (and only if) at least one NEW image was found, appends ONE synthetic
 *   user message (text note + image_url data URLs) right after the last
 *   tool message, on the OUTGOING copy only.
 *
 * The synthetic note is written as an explicit continuation instruction
 * ("This is not a new user request ... continue the existing task"), never
 * as a bare statement of the image's existence. When the original pending
 * user request can be extracted safely from the history, it is re-quoted
 * verbatim inside the note (disable with requoteOriginalRequest=false).
 *
 * The input history array is never mutated, and nothing here touches the
 * LM Studio UI state.
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
        } else if (typeof o.content === "string" && (o.content as string).trim().length > 0) {
          texts.push((o.content as string).trim());
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

/**
 * Find the original pending user request: the last `role === "user"` message
 * that appears before the last tool message (the request the tool call was
 * made to satisfy). Returns null when no such text exists.
 */
function findOriginalPendingRequest(messages: AnyMessage[]): string | null {
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as AnyMessage).role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
  const limit = lastToolIdx >= 0 ? lastToolIdx : messages.length;
  for (let i = limit - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || (m as AnyMessage).role !== "user") continue;
    const t = messageTextOf(m as AnyMessage);
    if (t) return t;
  }
  return null;
}

export function applyVisionBridge(opts: {
  ctl: unknown;
  messages: AnyMessage[];
  cfg: Config;
  seen: SeenTracker;
}): BridgeOutput {
  const wd = getWorkingDirectory(opts.ctl as Record<string, unknown>) ?? null;
  const baseDir = wd ?? process.cwd();
  const base = opts.messages.map((m, i) => toOpenAIMessage(m, i, baseDir));

  if (!opts.cfg.bridgeEnabled) {
    dbg("bridge", "bridge disabled via config (VISION_BRIDGE_ENABLED=false); sending history unchanged");
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
  }

  const toolIndices: number[] = [];
  opts.messages.forEach((m, i) => {
    if (m && typeof m === "object" && (m as AnyMessage).role === "tool") toolIndices.push(i);
  });

  if (toolIndices.length === 0) {
    dbg("bridge", "no tool-result messages in history; nothing to do");
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
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
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
  }

  const resolved = resolveImages(baseDir, allRefs, { maxImageBytes: opts.cfg.maxImageBytes });
  if (resolved.length === 0) {
    warn("bridge", "image references exist but no matching image file was found", {
      workingDirectory: baseDir,
      refs: allRefs.slice(0, 10).map((r) => r.value),
    });
    return { messages: base, injected: [], skippedDuplicates: 0, workingDirectory: wd };
  }
  info("bridge", "image candidate(s) resolved", resolved.map((im) => ({
    path: im.relativePath,
    matchedFrom: im.matchedFrom,
    sizeBytes: im.sizeBytes,
  })));

  const toolCallIdFor = (image: ResolvedImage): string | undefined => {
    // find the tool message whose refs produced this image (by basename)
    const base = image.relativePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    for (const i of toolIndices) {
      const refs = refsFromToolResult(opts.messages[i]);
      if (refs.some((r) => r.value.split(/[\\/]/).pop()?.toLowerCase() === base)) {
        const m = opts.messages[i] as AnyMessage;
        const id = m?.tool_call_id ?? m?.toolCallId;
        if (typeof id === "string") return id;
        return undefined;
      }
    }
    const last = toolIndices[toolIndices.length - 1];
    const m = opts.messages[last] as AnyMessage;
    const id = m?.tool_call_id ?? m?.toolCallId;
    return typeof id === "string" ? id : undefined;
  };

  const materialized: Array<{ image: ResolvedImage; dataUrl: string; toolCallId?: string }> = [];
  let skipped = 0;
  for (const image of resolved) {
    // Encode first: an image that fails to read must NOT be registered as
    // "seen" — otherwise it would be permanently skipped on later rounds.
    let dataUrl: string;
    try {
      dataUrl = fileToDataUrl(image.absPath, image.mimeType);
    } catch (e) {
      warn("bridge", `failed to encode image as data URL: ${image.relativePath}`, String(e));
      skipped++;
      continue;
    }
    const tci = toolCallIdFor(image);
    const reg = opts.seen.registerIfNew(image, tci);
    if (!reg.injected) {
      skipped++;
      continue;
    }
    materialized.push({ image, dataUrl, toolCallId: tci });
  }

  if (materialized.length === 0) {
    info("bridge", "all candidate images were duplicates or unreadable; sending history unchanged", { skipped });
    return { messages: base, injected: [], skippedDuplicates: skipped, workingDirectory: wd };
  }

  let syntheticText = opts.cfg.syntheticText;
  if (opts.cfg.requoteOriginalRequest) {
    const original = findOriginalPendingRequest(opts.messages);
    if (original) {
      syntheticText = [
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
    }
  }
  const syntheticParts: OpenAIPart[] = [{ type: "text", text: syntheticText }];
  for (const m of materialized) {
    syntheticParts.push({ type: "image_url", image_url: { url: m.dataUrl } });
  }
  const synthetic: OpenAIChatMessage = { role: "user", content: syntheticParts };

  let lastToolIdx = -1;
  for (let i = base.length - 1; i >= 0; i--) {
    if (base[i].role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
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
    injected: materialized.map((m) => ({
      relativePath: m.image.relativePath,
      mimeType: m.image.mimeType,
      sizeBytes: m.image.sizeBytes,
      dataUrlChars: m.dataUrl.length,
      matchedFrom: m.image.matchedFrom,
      toolCallId: m.toolCallId,
    })),
    skippedDuplicates: skipped,
    workingDirectory: wd,
  };
}
