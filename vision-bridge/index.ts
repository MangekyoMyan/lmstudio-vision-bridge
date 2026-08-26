/**
 * Package entry point (test harness + programmatic reuse).
 *
 * The OFFICIAL LM Studio plugin entry is src/index.ts (main(context)) —
 * that is the file the host / `lms dev` loads. This root index keeps the
 * long-standing named exports the test harness (scripts/harness/*.mjs,
 * via build/index.js) and external code rely on, and additionally
 * re-exports the official entry for convenience.
 *
 * The legacy default export is preserved so code written against the old
 * beta host API (default.export.generate(ctl) -> object with .generate())
 * keeps working against the still-supported VisionBridgeGenerator class.
 */
import { VisionBridgeGenerator } from "./src/generator.js";

export default {
  generate: (ctl: unknown) => new VisionBridgeGenerator(ctl),
};

// Official plugin entry (src/index.ts) — re-exported here as well.
export { main, generate } from "./src/index.js";

// Named exports (used by the test harness and for programmatic reuse).
export { VisionBridgeGenerator } from "./src/generator.js";
export { applyVisionBridge, applyVisionBridgeToOpenAI } from "./src/vision-bridge.js";
export { SeenTracker } from "./src/dedup.js";
export { extractImageRefs, extractFilePartRefs, resolveImages, refsFromToolResult, messageText } from "./src/image-detect.js";
export { toOpenAIMessage, toOpenAITools, fileToDataUrl, normalizeToolCallAny, extractAssistantToolCalls, guessMime, normalizeOpenAIMessage, normalizeOpenAIMessages, describeMessageShape } from "./src/messages.js";
export { loadConfig } from "./src/config.js";
export { configure as configureLog, log } from "./src/log.js";
export { chatCompletionStream } from "./src/openai-client.js";
export { getWorkingDirectory, getControllerTools, getModelInfo, reportToolCall } from "./src/controller.js";
export type { Config } from "./src/config.js";
