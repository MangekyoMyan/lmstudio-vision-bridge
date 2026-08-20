/**
 * Package entry point (prebuilt JS mirror of index.ts).
 * See index.ts / src/index.ts / src/generator.ts for full documentation.
 *
 * The OFFICIAL LM Studio plugin entry is src/index.ts (main(context)) —
 * that is the file the host / `lms dev` loads. This root index keeps the
 * long-standing named exports the test harness (scripts/harness/*.mjs,
 * via build/index.js) and external code rely on.
 */
import { VisionBridgeGenerator } from "./src/generator.js";

export default {
  generate: (ctl) => new VisionBridgeGenerator(ctl),
};

// Official plugin entry (src/index.ts) — re-exported here as well.
export { main, generate } from "./src/index.js";

// Named exports (used by the test harness and for programmatic reuse).
export { VisionBridgeGenerator } from "./src/generator.js";
export { applyVisionBridge } from "./src/vision-bridge.js";
export { SeenTracker } from "./src/dedup.js";
export { extractImageRefs, extractFilePartRefs, resolveImages, refsFromToolResult, messageText } from "./src/image-detect.js";
export { toOpenAIMessage, toOpenAITools, fileToDataUrl, normalizeToolCallAny, extractAssistantToolCalls, guessMime, normalizeOpenAIMessage, normalizeOpenAIMessages, describeMessageShape } from "./src/messages.js";
export { loadConfig } from "./src/config.js";
export { configure as configureLog, log } from "./src/log.js";
export { chatCompletionStream } from "./src/openai-client.js";
export { getWorkingDirectory, getControllerTools, getModelInfo, reportToolCall } from "./src/controller.js";
