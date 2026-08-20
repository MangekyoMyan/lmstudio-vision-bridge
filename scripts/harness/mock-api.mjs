// In-process OpenAI-compatible mock API for the Vision Bridge harness.
//
// Purpose: let Phase 1 tests exercise the REAL HTTP + SSE + tool-call pipeline
// (fetch -> generator -> loopback endpoint -> streamed response) deterministically,
// without needing LM Studio or a loaded model. The generator is completely
// unaware that the peer is a mock — it just talks OpenAI-compatible HTTP.
//
// Behavior per POST /v1/chat/completions:
//   - history contains a `tool` message        -> text "BRIDGE-OK" (or vision ack)
//   - request has `tools`, no tool result yet  -> a tool call `mock_tool` {"x":1}
//   - otherwise                                -> text "BRIDGE-OK" (or vision ack)
//   - any message carries an image_url data URL -> "MOCK-VISION-OK: I see N image(s)..."
//
// GET /v1/models is provided so api-smoke works against the mock as well.

import http from "node:http";

export const MOCK_MODEL_ID = "mock-qwen3.8-27b";

function countImages(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m && m.content;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p === "object" && p.type === "image_url") {
          const url = p.image_url && p.image_url.url;
          if (typeof url === "string" && url.startsWith("data:image/")) n += 1;
        }
      }
    }
  }
  return n;
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const half = Math.max(1, Math.ceil(text.length / 2));
  const a = text.slice(0, half);
  const b = text.slice(half);
  sse(res, {
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: MOCK_MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content: a } }],
  });
  sse(res, {
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: MOCK_MODEL_ID,
    choices: [{ index: 0, delta: b.length > 0 ? { content: b } : {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamToolCall(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, {
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: MOCK_MODEL_ID,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "mock_tool", arguments: "" } }],
      },
    }],
  });
  sse(res, {
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: MOCK_MODEL_ID,
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] },
    }],
  });
  sse(res, {
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: MOCK_MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Start the mock API. Returns { url, state, close() }.
 * `state.requests` records every chat completion (mode/imageCount/...) so
 * tests can assert what actually reached the "model" side.
 */
export async function startMockApi({ port = 18999, host = "127.0.0.1" } = {}) {
  const state = { requests: [], last: null };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL_ID, object: "model", owned_by: "harness" }] }));
      return;
    }

    if (req.method === "POST" && req.url && req.url.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid json body" } }));
          return;
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const imageCount = countImages(messages);
        const hasToolResult = messages.some((m) => m && m.role === "tool");
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        const mode = hasToolResult ? "after-tool" : hasTools ? "tool-call" : "text";

        state.requests.push({
          mode,
          imageCount,
          hasTools,
          hasToolResult,
          model: body.model,
          messageCount: messages.length,
          // wire-format assertion: every content must be a string or a parts
          // array — never null/object ("Got 'object'" server error)
          contentKinds: messages.map((m) =>
            m && m.content === null ? "null" : Array.isArray(m.content) ? "array" : typeof m.content
          ),
        });
        state.last = state.requests[state.requests.length - 1];

        if (mode === "tool-call") {
          streamToolCall(res);
          return;
        }
        const text =
          imageCount > 0
            ? `MOCK-VISION-OK: I see ${imageCount} image(s) in the conversation.`
            : "BRIDGE-OK";
        streamText(res, text);
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  // Track established connections so close() can tear them down explicitly.
  // The client (global fetch / undici) keeps its socket alive via HTTP
  // keep-alive after the response; without explicit teardown, server.close()
  // would wait for the client-side keep-alive timeout to expire, and a
  // forced process.exit() right after that can trip libuv's
  // UV_HANDLE_CLOSING assertion on Windows (observed with Node 24).
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    url: `http://${host}:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        // Stop accepting, then destroy the established (keep-alive)
        // connections so the 'close' event fires promptly; destroying the
        // server side also ends the client side of each socket (the undici
        // pool socket), letting the process exit cleanly afterwards.
        server.close(() => resolve());
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            /* socket already gone */
          }
        }
      }),
  };
}
