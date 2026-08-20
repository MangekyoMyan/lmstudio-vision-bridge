// Phase 1d: drive the OFFICIAL generator (src/index.ts::generate, via the
// build mirror) with a faithful stand-in for the @lmstudio/sdk `Chat` CLASS —
// the exact shape the real LM Studio host passes as the second argument:
//
//   Generator = (ctl: GeneratorController, history: Chat) => Promise
//
// This test reproduces the real-hold failure (messages:0 -> 400 empty
// messages) and proves the adapter converts:
//   - user text            -> plain user message
//   - assistant toolCall   -> tool_calls (OpenAI shape)
//   - tool results         -> {role:"tool", tool_call_id, content}
//   - user-attached image  -> file part (materialized to a data URL)
//   - MCP tool-result image ref -> Vision Bridge synthetic injection
//   - empty Chat           -> NO POST (safe guard) + warning fragment
//
// Deterministic: loopback goes to the in-process mock OpenAI API.
//   npm run phase1:sdkchat
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startMockApi } = await import("./mock-api.mjs");
const { writeFixtureImage } = await import("./fixture-image.mjs");
const { generate } = await import("../../vision-bridge/build/index.js");

let failures = 0;
let warns = 0;
function check(ok, label, detail) {
  const pass = ok ? "PASS" : "FAIL";
  console.log(`${pass} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// --- Faithful stand-ins for the @lmstudio/sdk classes -----------------------
// (mirrors lmstudio-js packages/lms-client/src/Chat.ts + files/FileHandle.ts)

class SdkChatMessage {
  constructor({ role, text = "", toolCallRequests = [], toolCallResults = [], files = [] }) {
    this.role = role;
    this.text = text;
    this.tcs = toolCallRequests;
    this.results = toolCallResults;
    this.files = files;
  }
  getRole() {
    return this.role;
  }
  getText() {
    return this.text;
  }
  getToolCallRequests() {
    return this.tcs;
  }
  getToolCallResults() {
    return this.results;
  }
  getFiles(_client) {
    return this.files;
  }
  hasFiles() {
    return this.files.length > 0;
  }
}

class SdkChat {
  constructor(messages) {
    this.messages = messages;
  }
  getLength() {
    return this.messages.length;
  }
  get length() {
    return this.messages.length;
  }
  at(i) {
    const n = this.messages.length;
    const j = i < 0 ? n + i : i;
    if (j < 0 || j >= n) throw new RangeError("index out of bounds");
    return this.messages[j];
  }
  getMessagesArray() {
    return [...this.messages];
  }
  getSystemPrompt() {
    return "";
  }
  [Symbol.iterator]() {
    return this.messages[Symbol.iterator]();
  }
}

// FileHandle stand-in (name, isImage(), getFilePath() -> Promise<string>)
function fileHandle(absPath, name, image = true) {
  return {
    name,
    sizeBytes: fs.statSync(absPath).size,
    isImage: () => image,
    getFilePath: async () => absPath,
  };
}

// GeneratorController stand-in (current host API surface)
function makeCtl({ wd, tools, report }) {
  return {
    client: { __mockLmStudioClient: true },
    abortSignal: new AbortController().signal,
    getWorkingDirectory: () => wd,
    getToolDefinitions: () => tools,
    fragmentGenerated: (t) => {
      report.fragments.push(t);
    },
    toolCallGenerationStarted: () => {
      report.toolCallEvents.push("started");
    },
    toolCallGenerationNameReceived: (n) => {
      report.toolCallEvents.push(`name:${n}`);
    },
    toolCallGenerationArgumentFragmentGenerated: (s) => {
      report.toolCallEvents.push(`args:${s}`);
    },
    toolCallGenerationEnded: (tc) => {
      report.toolCallEvents.push("ended");
      report.reportedToolCalls.push(tc);
    },
    toolCallGenerationFailed: (e) => {
      report.toolCallEvents.push(`failed:${String(e)}`);
    },
  };
}

const toolDef = {
  type: "function",
  function: {
    name: "mock_tool",
    description: "Harness tool used to verify tool-call reporting.",
    parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
  },
};

// --- Setup -------------------------------------------------------------------
const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-phase1-sdkchat-"));
const mock = await startMockApi({ port: 18998 });
process.env.VISION_BRIDGE_API_ROOT = mock.url;
process.env.VISION_BRIDGE_LOG_LEVEL = process.env.VISION_BRIDGE_LOG_LEVEL || "info";
console.log(`[harness] official generate() via build mirror; mock API at ${mock.url}`);

const newReport = () => ({ fragments: [], reportedToolCalls: [], toolCallEvents: [] });
const textOf = (r) => r.fragments.join("");
const lastReq = () => mock.state.last;

// --- 1. plain text round trip (SDK Chat with one user message) ---------------
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [], report });
  const chat = new SdkChat([
    new SdkChatMessage({ role: "user", text: "Respond with exactly the token BRIDGE-OK and nothing else." }),
  ]);
  await generate(ctl, chat);
  const out = textOf(report);
  check(mock.state.last && mock.state.last.messageCount === 1, "SDK Chat history reaches the API (1 message)", `messageCount=${mock.state.last?.messageCount}`);
  check(!out.startsWith("⚠️"), "no bridge/API error surfaced", out.slice(0, 200));
  check(out.includes("BRIDGE-OK"), "model text streamed back to the controller", `"${out.trim().slice(0, 80)}"`);
}

// --- 2. tool call: model side -> reported via the NEW controller API ---------
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [toolDef], report });
  const chat = new SdkChat([
    new SdkChatMessage({ role: "user", text: 'Call the mock_tool tool now with argument {"x": 1}.' }),
  ]);
  await generate(ctl, chat);
  check(
    report.reportedToolCalls.length === 1,
    "tool call reported to LM Studio via toolCallGeneration* API",
    `events=${report.toolCallEvents.join(">")}`
  );
  const tc = report.reportedToolCalls[0];
  let argsOk = false;
  try {
    argsOk = JSON.parse(tc?.arguments ?? "{}").x === 1;
  } catch {
    argsOk = false;
  }
  check(
    tc && tc.name === "mock_tool" && argsOk,
    "reported tool call payload is well-formed (name/args)",
    JSON.stringify(tc ?? null)
  );
}

// --- 3. tool-result history round-trips (assistant toolCall + tool result) ---
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [toolDef], report });
  const before = mock.state.requests.length;
  const chat = new SdkChat([
    new SdkChatMessage({ role: "user", text: 'Call the mock_tool tool now with argument {"x": 1}.' }),
    new SdkChatMessage({
      role: "assistant",
      text: "",
      toolCallRequests: [{ id: "call_1", type: "function", name: "mock_tool", arguments: { x: 1 } }],
    }),
    new SdkChatMessage({
      role: "tool",
      text: "",
      toolCallResults: [{ content: "tool result: ok (x=1)", toolCallId: "call_1" }],
    }),
  ]);
  await generate(ctl, chat);
  const last = lastReq();
  check(last && last.messageCount === 3, "3-message history reaches the API", `messageCount=${last?.messageCount}`);
  check(last && last.hasToolResult === true, "tool message converted to OpenAI tool role", `hasToolResult=${last?.hasToolResult}`);
  check(mock.state.requests.length === before + 1, "exactly one API round for this history", "");
  check(!textOf(report).startsWith("⚠️"), "no bridge/API error surfaced", textOf(report).slice(0, 200));
}

// --- 4. vision: user-attached image file (manual attachment path) ------------
{
  const imgFile = path.join(wd, "manual-attach.png");
  writeFixtureImage(imgFile);
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [], report });
  const chat = new SdkChat([
    new SdkChatMessage({
      role: "user",
      text: "What do you see in the attached image?",
      files: [fileHandle(imgFile, "manual-attach.png")],
    }),
  ]);
  await generate(ctl, chat);
  const last = lastReq();
  check(last && last.imageCount >= 1, "attached image became a data URL seen by the model", `imageCount=${last?.imageCount}`);
  check(textOf(report).includes("MOCK-VISION-OK"), "vision ack streamed back", `"${textOf(report).trim().slice(0, 80)}"`);
}

// --- 5. vision: MCP tool-result image -> Vision Bridge synthetic injection ---
{
  const shotFile = path.join(wd, "shot.png");
  // NOTE: different pixel content from scenario 4 on purpose — the dedup
  // tracker keys on content SHA-256, so identical content would be (correctly)
  // skipped here and mask the injection we want to verify.
  writeFixtureImage(shotFile, () => [30, 220, 30]); // green fixture
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [toolDef], report });
  const chat = new SdkChat([
    new SdkChatMessage({ role: "user", text: "Make a screenshot and describe what is in it." }),
    new SdkChatMessage({
      role: "assistant",
      text: "",
      toolCallRequests: [{ id: "call_2", type: "function", name: "mock_tool", arguments: { x: 1 } }],
    }),
    new SdkChatMessage({
      role: "tool",
      text: "",
      toolCallResults: [{ content: "Screenshot saved: fileName: shot.png", toolCallId: "call_2" }],
    }),
  ]);
  await generate(ctl, chat);
  const last = lastReq();
  check(last && last.hasToolResult === true, "MCP tool result reached the API", `hasToolResult=${last?.hasToolResult}`);
  check(last && last.imageCount >= 1, "Vision Bridge injected the tool-result image", `imageCount=${last?.imageCount}`);
  check(textOf(report).includes("MOCK-VISION-OK"), "vision ack streamed back after injection", `"${textOf(report).trim().slice(0, 80)}"`);
}

// --- 6. empty Chat: safe guard (no POST, warning fragment, no crash) ---------
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [toolDef], report });
  const before = mock.state.requests.length;
  let threw = null;
  try {
    await generate(ctl, new SdkChat([]));
  } catch (e) {
    threw = e;
  }
  check(threw === null, "empty Chat does not throw", threw ? String(threw) : "");
  check(mock.state.requests.length === before, "no API POST for an empty history", `requests=${before} -> ${mock.state.requests.length}`);
  check(textOf(report).includes("⚠️ Vision Bridge"), "warning fragment surfaced to the chat UI", `"${textOf(report).trim().slice(0, 100)}"`);
}

// --- 7. backward compatibility: plain-array history still works --------------
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [], report });
  await generate(ctl, [{ role: "user", content: "Respond with exactly the token BRIDGE-OK and nothing else." }]);
  const last = lastReq();
  check(last && last.messageCount === 1, "plain-array history still works (harness compat)", `messageCount=${last?.messageCount}`);
  check(textOf(report).includes("BRIDGE-OK"), "text round trip ok for array shape", `"${textOf(report).trim().slice(0, 80)}"`);
}

// --- 8. empty-content messages -> official string types (no null/object) -----
// Regression for the real-host LM Studio 400:
//   "Your payload's 'messages' array in misformatted. Messages from roles
//    [user, system, tool] must contain a 'content' field. Got 'object'."
// Root cause: content:null (typeof null === "object") on user/system/
// assistant messages without extractable text. The official
// toOpenAIMessages() always sends a string (message.getText()), even "".
{
  const report = newReport();
  const ctl = makeCtl({ wd, tools: [toolDef], report });
  const chat = new SdkChat([
    new SdkChatMessage({ role: "system", text: "" }), // empty system prompt
    new SdkChatMessage({ role: "user", text: "" }), // image-only style: no text
    new SdkChatMessage({
      role: "assistant",
      text: "",
      toolCallRequests: [{ id: "call_8", type: "function", name: "mock_tool", arguments: { x: 1 } }],
    }),
    new SdkChatMessage({ role: "tool", text: "", toolCallResults: [{ content: "ok (x=1)", toolCallId: "call_8" }] }),
  ]);
  await generate(ctl, chat);
  const last = lastReq();
  check(last && last.messageCount === 4, "empty-content history reaches the API (4 messages)", `messageCount=${last?.messageCount}`);
  const kinds = last?.contentKinds ?? [];
  check(
    kinds.length === 4 && kinds.every((k) => k === "string" || k === "array"),
    "every outgoing content is string or array (no null/object on the wire)",
    JSON.stringify(kinds)
  );
  check(!textOf(report).startsWith("⚠️"), "no bridge/API error surfaced", textOf(report).slice(0, 200));
}

await mock.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => {
  process.exit(process.exitCode);
}, 2000).unref?.();
