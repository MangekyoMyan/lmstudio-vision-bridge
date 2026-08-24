"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportToolCall = exports.getModelInfo = exports.getControllerTools = exports.getWorkingDirectory = exports.chatCompletionStream = exports.log = exports.configureLog = exports.loadConfig = exports.describeMessageShape = exports.normalizeOpenAIMessages = exports.normalizeOpenAIMessage = exports.guessMime = exports.extractAssistantToolCalls = exports.normalizeToolCallAny = exports.fileToDataUrl = exports.toOpenAITools = exports.toOpenAIMessage = exports.messageText = exports.refsFromToolResult = exports.resolveImages = exports.extractFilePartRefs = exports.extractImageRefs = exports.SeenTracker = exports.applyVisionBridge = exports.VisionBridgeGenerator = exports.generate = exports.main = void 0;
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
const generator_js_1 = require("./src/generator.js");
exports.default = {
    generate: (ctl) => new generator_js_1.VisionBridgeGenerator(ctl),
};
// Official plugin entry (src/index.ts) — re-exported here as well.
var index_js_1 = require("./src/index.js");
Object.defineProperty(exports, "main", { enumerable: true, get: function () { return index_js_1.main; } });
Object.defineProperty(exports, "generate", { enumerable: true, get: function () { return index_js_1.generate; } });
// Named exports (used by the test harness and for programmatic reuse).
var generator_js_2 = require("./src/generator.js");
Object.defineProperty(exports, "VisionBridgeGenerator", { enumerable: true, get: function () { return generator_js_2.VisionBridgeGenerator; } });
var vision_bridge_js_1 = require("./src/vision-bridge.js");
Object.defineProperty(exports, "applyVisionBridge", { enumerable: true, get: function () { return vision_bridge_js_1.applyVisionBridge; } });
var dedup_js_1 = require("./src/dedup.js");
Object.defineProperty(exports, "SeenTracker", { enumerable: true, get: function () { return dedup_js_1.SeenTracker; } });
var image_detect_js_1 = require("./src/image-detect.js");
Object.defineProperty(exports, "extractImageRefs", { enumerable: true, get: function () { return image_detect_js_1.extractImageRefs; } });
Object.defineProperty(exports, "extractFilePartRefs", { enumerable: true, get: function () { return image_detect_js_1.extractFilePartRefs; } });
Object.defineProperty(exports, "resolveImages", { enumerable: true, get: function () { return image_detect_js_1.resolveImages; } });
Object.defineProperty(exports, "refsFromToolResult", { enumerable: true, get: function () { return image_detect_js_1.refsFromToolResult; } });
Object.defineProperty(exports, "messageText", { enumerable: true, get: function () { return image_detect_js_1.messageText; } });
var messages_js_1 = require("./src/messages.js");
Object.defineProperty(exports, "toOpenAIMessage", { enumerable: true, get: function () { return messages_js_1.toOpenAIMessage; } });
Object.defineProperty(exports, "toOpenAITools", { enumerable: true, get: function () { return messages_js_1.toOpenAITools; } });
Object.defineProperty(exports, "fileToDataUrl", { enumerable: true, get: function () { return messages_js_1.fileToDataUrl; } });
Object.defineProperty(exports, "normalizeToolCallAny", { enumerable: true, get: function () { return messages_js_1.normalizeToolCallAny; } });
Object.defineProperty(exports, "extractAssistantToolCalls", { enumerable: true, get: function () { return messages_js_1.extractAssistantToolCalls; } });
Object.defineProperty(exports, "guessMime", { enumerable: true, get: function () { return messages_js_1.guessMime; } });
Object.defineProperty(exports, "normalizeOpenAIMessage", { enumerable: true, get: function () { return messages_js_1.normalizeOpenAIMessage; } });
Object.defineProperty(exports, "normalizeOpenAIMessages", { enumerable: true, get: function () { return messages_js_1.normalizeOpenAIMessages; } });
Object.defineProperty(exports, "describeMessageShape", { enumerable: true, get: function () { return messages_js_1.describeMessageShape; } });
var config_js_1 = require("./src/config.js");
Object.defineProperty(exports, "loadConfig", { enumerable: true, get: function () { return config_js_1.loadConfig; } });
var log_js_1 = require("./src/log.js");
Object.defineProperty(exports, "configureLog", { enumerable: true, get: function () { return log_js_1.configure; } });
Object.defineProperty(exports, "log", { enumerable: true, get: function () { return log_js_1.log; } });
var openai_client_js_1 = require("./src/openai-client.js");
Object.defineProperty(exports, "chatCompletionStream", { enumerable: true, get: function () { return openai_client_js_1.chatCompletionStream; } });
var controller_js_1 = require("./src/controller.js");
Object.defineProperty(exports, "getWorkingDirectory", { enumerable: true, get: function () { return controller_js_1.getWorkingDirectory; } });
Object.defineProperty(exports, "getControllerTools", { enumerable: true, get: function () { return controller_js_1.getControllerTools; } });
Object.defineProperty(exports, "getModelInfo", { enumerable: true, get: function () { return controller_js_1.getModelInfo; } });
Object.defineProperty(exports, "reportToolCall", { enumerable: true, get: function () { return controller_js_1.reportToolCall; } });
