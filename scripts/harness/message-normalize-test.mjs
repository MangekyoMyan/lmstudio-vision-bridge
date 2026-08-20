// Conversion test: official OpenAI message-shape enforcement (deterministic,
// no API / model needed).
//
// Regression test for the LM Studio 400:
//   "Your payload's 'messages' array in misformatted. Messages from roles
//    [user, system, tool] must contain a 'content' field. Got 'object'."
//
// Root cause: toOpenAIMessage() emitted `content: null` for user/system/
// assistant messages without extractable text (empty user text, image-only
// attach whose file part could not be materialized, empty assistant
// tool-call message, ...). `typeof null === "object"`, so the server
// reported "Got 'object'". The official toOpenAIMessages() always emits a
// STRING (message.getText()), even an empty one.
//
// This test pins the official invariants:
//   system:    { role:"system",    content: string }
//   user:      { role:"user",      content: string | [text/image_url parts] }
//   assistant: { role:"assistant", content: string, tool_calls? }
//   tool:      { role:"tool",      tool_call_id: string, content: string }
//
//   npm run phase1:messages

import {
  toOpenAIMessage,
  normalizeOpenAIMessage,
  normalizeOpenAIMessages,
  describeMessageShape,
} from "../../vision-bridge/build/index.js";

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const kind = (v) => (v === null ? "null" : v === undefined ? "undefined" : Array.isArray(v) ? "array" : typeof v);

// --- 1. toOpenAIMessage: content is never null ------------------------------
{
  const user = toOpenAIMessage({ role: "user", content: "" }, 0);
  check(kind(user.content) === "string" && user.content === "", "empty user message -> content '' (string, not null)", JSON.stringify(user));

  const userNull = toOpenAIMessage({ role: "user", content: null }, 0);
  check(kind(userNull.content) === "string", "null user content -> string", JSON.stringify(userNull));

  const system = toOpenAIMessage({ role: "system", content: "" }, 0);
  check(kind(system.content) === "string", "empty system message -> content '' (string)", JSON.stringify(system));

  const assistant = toOpenAIMessage(
    { role: "assistant", content: "", toolCallRequest: { id: "call_1", tool: "mock_tool", args: { x: 1 } } },
    0
  );
  check(kind(assistant.content) === "string", "assistant tool-call message (empty text) -> content '' (string)", JSON.stringify(assistant));
  check(
    Array.isArray(assistant.tool_calls) && assistant.tool_calls[0].function.name === "mock_tool",
    "assistant tool_calls preserved",
    JSON.stringify(assistant.tool_calls ?? null)
  );

  const tool = toOpenAIMessage({ role: "tool", tool_call_id: "call_1", content: "" }, 0);
  check(kind(tool.content) === "string" && tool.tool_call_id === "call_1", "empty tool message -> content '' + tool_call_id", JSON.stringify(tool));
}

// --- 2. toOpenAIMessage: raw object content is extracted, never forwarded ---
{
  const a = toOpenAIMessage({ role: "user", content: { type: "text", text: "hi" } }, 0);
  check(a.content === "hi", "raw {type:text} object content -> text extracted", JSON.stringify(a));

  const b = toOpenAIMessage({ role: "user", content: { foo: 1 } }, 0);
  check(kind(b.content) === "string", "raw object content (no text) -> string, not object", JSON.stringify(b));
}

// --- 3. toOpenAIMessage: vision array content preserved ----------------------
{
  const v = toOpenAIMessage(
    {
      role: "user",
      content: [
        { type: "text", text: "note" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJDREVG" } },
      ],
    },
    0
  );
  check(kind(v.content) === "array", "user text+image array kept as array", JSON.stringify(v).slice(0, 140));
  check(
    v.content[0].type === "text" && v.content[1].type === "image_url",
    "part order/types: text then image_url",
    JSON.stringify(v.content.map((p) => p.type))
  );
}

// --- 4. normalizeOpenAIMessage: official shape per role ----------------------
{
  const system = normalizeOpenAIMessage({ role: "system", content: null }, 0);
  check(system && kind(system.content) === "string", "system null content -> string", JSON.stringify(system));

  const userArr = normalizeOpenAIMessage(
    {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
        { junk: true },
      ],
    },
    0
  );
  check(
    kind(userArr.content) === "array" && userArr.content.map((p) => p.type).join(",") === "text,image_url",
    "user array: valid text/image_url parts kept, junk dropped",
    JSON.stringify(userArr.content.map((p) => p.type))
  );

  const assistantArr = normalizeOpenAIMessage(
    { role: "assistant", content: ["x", { type: "text", text: "y" }], tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    0
  );
  check(assistantArr.content === "x\ny", "assistant array content flattened to string", JSON.stringify(assistantArr.content));
  check(Array.isArray(assistantArr.tool_calls) && assistantArr.tool_calls.length === 1, "assistant tool_calls preserved", "");

  const toolArr = normalizeOpenAIMessage({ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "res" }] }, 0);
  check(toolArr.content === "res" && toolArr.tool_call_id === "c1", "tool array content flattened to string", JSON.stringify(toolArr));

  const noId = normalizeOpenAIMessage({ role: "tool", content: "x" }, 3);
  check(typeof noId.tool_call_id === "string" && noId.tool_call_id.length > 0, "tool without id gets a generated tool_call_id", JSON.stringify(noId));
}

// --- 5. normalizeOpenAIMessages: array level ---------------------------------
{
  const out = normalizeOpenAIMessages([
    { role: "user", content: "hello" },
    null,
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }] },
    42,
  ]);
  check(out.length === 2, "invalid entries dropped, valid kept", `out.length=${out.length}`);
  check(
    kind(out[1].content) === "array" && out[1].content[0].type === "image_url",
    "image-only user message stays a vision array",
    JSON.stringify(out[1].content.map((p) => p.type))
  );
}

// --- 6. idempotency -----------------------------------------------------------
{
  const sample = [
    { role: "system", content: "" },
    { role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "n", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: "r" },
  ];
  const once = normalizeOpenAIMessages(sample);
  const twice = normalizeOpenAIMessages(once);
  check(JSON.stringify(once) === JSON.stringify(twice), "normalization is idempotent", "");
}

// --- 7. describeMessageShape: diagnostic fields -------------------------------
{
  const d1 = describeMessageShape({ role: "user", content: null }, 0);
  check(
    d1.index === 0 && d1.role === "user" && d1.typeofContent === "object" && d1.isArray === false,
    "null content described as typeof object / not array",
    JSON.stringify(d1)
  );

  const d2 = describeMessageShape(
    { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }] },
    1
  );
  check(Array.isArray(d2.partTypes) && d2.partTypes.join(",") === "text,image_url", "array part types listed", JSON.stringify(d2.partTypes));

  const d3 = describeMessageShape({ role: "user", content: "hello" }, 2);
  check(d3.typeofContent === "string" && d3.chars === 5, "string content described (length only, no body)", JSON.stringify(d3));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
