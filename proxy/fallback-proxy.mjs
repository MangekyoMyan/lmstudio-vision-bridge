#!/usr/bin/env node
// Fallback thin LLM proxy (SECOND CHOICE — only needed if the in-UI loopback
// deadlocks: "api_queued (202)" / "api_error 503" / "api_timeout").
//
// What it does:
//   Forwards OpenAI-compatible requests (streaming included) from the
//   Vision Bridge generator to a SECOND inference endpoint — e.g. a second
//   LM Studio instance with Qwen3.8-27B loaded, or `lms serve`.
//
// What it deliberately does NOT do:
//   - no MCP client, no tool execution — MCP execution STAYS with the
//     original LM Studio (tool calls are still reported via the controller)
//   - no UI automation
//
// Usage:
//   $env:PROXY_TARGET = "http://127.0.0.1:18081"   # second inference endpoint
//   node proxy\fallback-proxy.mjs                    # listens on 127.0.0.1:18080
//
// Then point the generator at the proxy:
//   <working directory>/.vision-bridge/config.json  ->  { "apiRoot": "http://127.0.0.1:18080" }
//   (or env VISION_BRIDGE_API_ROOT)

import http from "node:http";

const HOST = process.env.PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.PROXY_PORT || 18080);
const TARGET = (process.env.PROXY_TARGET || "http://127.0.0.1:18081").replace(/\/+$/, "");
const TARGET_KEY = process.env.PROXY_TARGET_API_KEY || "";

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  const url = `${TARGET}${req.url || "/"}`;
  const headers = { ...req.headers };
  delete headers.host;
  if (TARGET_KEY) headers.authorization = `Bearer ${TARGET_KEY}`;

  const t0 = Date.now();
  const upstream = http.request(url, { method: req.method, headers }, (up) => {
    console.log(
      `[proxy] ${req.method} ${req.url} -> ${up.statusCode} (${Date.now() - t0} ms)${
        (up.headers["content-type"] || "").includes("event-stream") ? " [streaming]" : ""
      }`
    );
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });

  upstream.on("error", (e) => {
    console.error(`[proxy] upstream error for ${req.url}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: `fallback proxy upstream error: ${e.message}`, type: "proxy_error" } }));
  });

  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`[proxy] fallback LLM proxy listening on http://${HOST}:${PORT}`);
  console.log(`[proxy] forwarding to ${TARGET}`);
  console.log(`[proxy] started ${new Date(startedAt).toISOString()}`);
});
