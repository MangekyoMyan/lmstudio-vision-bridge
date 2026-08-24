/**
 * Chat history conversion: LM Studio message shapes -> OpenAI-compatible
 * shapes (for the loopback API). Deliberately permissive: unknown parts are
 * skipped with a debug log, never fatal.
 *
 * Important constraints honored here:
 *  - `tool` messages: images are NEVER attached (SDK constraint). File parts
 *    in tool results are flattened to "[attached file: ...]" text notes.
 *  - assistant tool calls: both LM style (toolCallRequest) and OpenAI style
 *    (tool_calls) are understood.
 */
import fs from "node:fs";
import path from "node:path";
import { dbg, warn } from "./log.js";
import { BridgeError, type AnyMessage, type OpenAIChatMessage, type OpenAIImagePart, type OpenAIPart, type OpenAIToolCall, type OpenAIToolDef } from "./types.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export function guessMime(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "image/png";
}

function partString(p: unknown, key: string): string | null {
  if (p && typeof p === "object") {
    const v = (p as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function fileToDataUrl(absPath: string, mimeTypeHint?: string | null): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch (e) {
    throw new BridgeError("image_read_failed", `cannot read image file: ${absPath} — ${(e as Error).message}`);
  }
  const mime = mimeTypeHint && mimeTypeHint.startsWith("image/") ? mimeTypeHint : guessMime(absPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Try to materialize a file-part into an image part (data URL). */
function partImagePart(p: unknown, baseDir?: string | null): OpenAIPart | null {
  if (!p || typeof p !== "object") return null;
  const fp = ["path", "file_path", "filePath", "url", "file_name", "fileName", "name", "src"]
    .map((k) => partString(p, k))
    .find((v) => v !== null);
  if (!fp) return null;
  if (fp.startsWith("data:")) {
    return /^data:image\//.test(fp) ? { type: "image_url", image_url: { url: fp } } : null;
  }
  const mime = ["mime_type", "mimeType", "mime", "content_type", "contentType"]
    .map((k) => partString(p, k))
    .find((v) => v !== null) ?? null;

  const isAbs = path.isAbsolute(fp) || /^[A-Za-z]:[\\/]/.test(fp);
  const candidates = isAbs ? [fp] : [
    ...(baseDir ? [path.join(baseDir, fp)] : []),
    path.resolve(process.cwd(), fp),
    fp,
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        dbg("msg", `materialized file part as data URL`, { file: c });
        return { type: "image_url", image_url: { url: fileToDataUrl(c, mime) } };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export function toOpenAIMessage(m: AnyMessage, index: number, baseDir?: string | null): OpenAIChatMessage {
  const roleRaw = typeof m?.role === "string" ? m.role : "user";
  const role = (["system", "user", "assistant", "tool"].includes(roleRaw) ? roleRaw : "user") as OpenAIChatMessage["role"];
  const content = m?.content;
  const texts: string[] = [];
  const parts: OpenAIPart[] = [];
  const allowImages = role === "user"; // OpenAI vision parts are valid only on user messages

  if (typeof content === "string") {
    if (content.length > 0) texts.push(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw === "string") {
        if (raw.length > 0) texts.push(raw);
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const t = partString(o, "text") ?? (typeof o.content === "string" ? o.content : null);
      if (t !== null && t.length > 0) {
        texts.push(t);
        continue;
      }
      if (allowImages) {
        // Already-materialized OpenAI vision part. Previously this path was
        // accidentally dropped because partImagePart() only looked for a
        // top-level path/url and did not inspect image_url.url.
        const iu = o.image_url;
        if (iu && typeof iu === "object") {
          const url = (iu as Record<string, unknown>).url;
          if (typeof url === "string" && url.length > 0) {
            parts.push({ type: "image_url", image_url: { url } });
            continue;
          }
        }
        const img = partImagePart(o, baseDir);
        if (img) {
          parts.push(img);
          continue;
        }
      } else if (partString(o, "file_name") || partString(o, "path") || partString(o, "name")) {
        // tool result referencing a file: keep it visible to the model as text
        const name = partString(o, "file_name") ?? partString(o, "fileName") ?? partString(o, "name") ?? partString(o, "path") ?? "file";
        texts.push(`[attached file: ${name}]`);
        continue;
      }
      dbg("msg", `skipping unrecognized content part in message[${index}]`, Object.keys(o).slice(0, 12));
    }
  } else if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    const t = partString(o, "text");
    if (t) texts.push(t);
    else if (allowImages) {
      const iu = o.image_url;
      if (iu && typeof iu === "object" && typeof (iu as Record<string, unknown>).url === "string") {
        parts.push({ type: "image_url", image_url: { url: (iu as Record<string, unknown>).url as string } });
      } else {
        const img = partImagePart(o, baseDir);
        if (img) parts.push(img);
      }
    }
  }

  const out: OpenAIChatMessage = { role, content: "" };
  if (parts.length > 0) {
    out.content = texts.length > 0 ? [{ type: "text", text: texts.join("\n") }, ...parts] : parts;
  } else if (texts.length > 0) {
    out.content = texts.join("\n");
  }

  if (role === "assistant") {
    const tcs = extractAssistantToolCalls(m, index);
    if (tcs.length > 0) out.tool_calls = tcs;
  }

  if (role === "tool") {
    const id =
      partString(m, "tool_call_id") ?? partString(m, "toolCallId") ?? partString(m, "call_id") ?? `call_vb_t${index}`;
    out.tool_call_id = id;
  }

  // Official toOpenAIMessages() invariant: content is ALWAYS a string
  // (message.getText()), even an empty one — never null, never a raw object.
  // JSON `null` is `typeof "object"`, which LM Studio's payload validator
  // rejects with: "Messages from roles [user, system, tool] must contain a
  // 'content' field. Got 'object'." (Before this fix, user/system/assistant
  // messages without extractable text were sent with content:null.)
  return out;
}

/**
 * --- Official-shape enforcement (final wire format) ------------------------
 *
 * Mirrors the official openai-compat-endpoint toOpenAIMessages():
 *
 *   system:    { role: "system",    content: <string> }
 *   user:      { role: "user",      content: <string> }
 *              (Vision: content: [{type:"text",...}, {type:"image_url",...}])
 *   assistant: { role: "assistant", content: <string>, tool_calls? }
 *   tool:      { role: "tool",      tool_call_id: <string>, content: <string> }
 *
 * Invariants (the official implementation never violates these):
 *  - content is ALWAYS a string (even an empty one) — never null, never a
 *    raw object. JSON `null` is `typeof "object"`, which LM Studio rejects
 *    with "...must contain a 'content' field. Got 'object'."
 *  - content arrays are allowed ONLY for `user` messages and only with
 *    well-formed text / image_url parts (the Vision Bridge synthetic
 *    message and attached-image user messages rely on this).
 *  - LM Studio internal shapes (ChatMessage instances, getRaw() objects,
 *    file parts) are NEVER forwarded: text is extracted, the rest is dropped
 *    with a log.
 */
function extractTextOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  return null;
}

export function normalizeOpenAIMessage(m: unknown, index: number): OpenAIChatMessage | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    dbg("msg", `message[${index}] is not a plain object; dropping from wire payload`, String(m));
    return null;
  }
  const o = m as Record<string, unknown>;
  if (typeof o.role !== "string") {
    dbg("msg", `message[${index}] has no string role; dropping from wire payload`, Object.keys(o).slice(0, 12));
    return null;
  }
  const role = (["system", "user", "assistant", "tool"].includes(o.role) ? o.role : "user") as OpenAIChatMessage["role"];

  const content = o.content;
  const texts: string[] = [];
  const imageParts: OpenAIImagePart[] = [];
  const pushText = (t: string | null): void => {
    if (t !== null && t.length > 0) texts.push(t);
  };

  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw === "string") {
        pushText(raw);
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      // image_url part (official vision shape) — keep only for user messages
      const iu = p.image_url;
      if (p.type === "image_url" || (iu && typeof iu === "object")) {
        const u = (iu as Record<string, unknown> | null | undefined)?.url;
        if (typeof u === "string" && u.length > 0) {
          imageParts.push({ type: "image_url", image_url: { url: u } });
          continue;
        }
        dbg("msg", `message[${index}] dropping image part with missing/invalid url`, Object.keys(p).slice(0, 12));
        continue;
      }
      // text part / LM raw part: extract the text only
      pushText(extractTextOf(p));
      if (p.type !== undefined && p.type !== "text" && p.type !== "image_url") {
        dbg("msg", `message[${index}] dropping unsupported content part`, { partType: String(p.type), keys: Object.keys(p).slice(0, 12) });
      } else if (p.type === undefined && (p.path !== undefined || p.file_name !== undefined || p.fileName !== undefined || p.name !== undefined)) {
        dbg("msg", `message[${index}] dropping unmaterialized file part`, { name: p.name ?? p.file_name ?? p.fileName ?? p.path });
      }
    }
  } else if (content !== null && content !== undefined && typeof content === "object") {
    // Raw object content (LM Studio internal shape / getRaw() object).
    // Extract text only — the raw object is NEVER forwarded.
    const o2 = content as Record<string, unknown>;
    const iu = o2.image_url;
    if (iu && typeof iu === "object" && typeof (iu as Record<string, unknown>).url === "string") {
      imageParts.push({ type: "image_url", image_url: { url: (iu as Record<string, unknown>).url as string } });
    }
    pushText(extractTextOf(content));
    dbg("msg", `message[${index}] content was a raw object; text extracted, object NOT forwarded`, Object.keys(o2).slice(0, 12));
  } else if (content === undefined || content === null) {
    dbg("msg", `message[${index}] content is ${String(content)}; normalizing to empty string`);
  }

  const out: OpenAIChatMessage = { role, content: "" };
  if (role !== "user" && imageParts.length > 0) {
    dbg("msg", `message[${index}] (${role}) dropped ${imageParts.length} image part(s) — images are only allowed on user messages`);
  }
  if (role === "user" && imageParts.length > 0) {
    // Official vision shape: text part first, then image_url parts.
    out.content = texts.length > 0 ? [{ type: "text", text: texts.join("\n") }, ...imageParts] : [...imageParts];
  } else if (texts.length > 0) {
    out.content = texts.join("\n");
  } else {
    // Official invariant: content is always a string (even ""), never null.
    out.content = "";
  }

  if (role === "assistant") {
    const tcs = extractAssistantToolCalls(o, index);
    if (tcs.length > 0) {
      out.tool_calls = tcs;
    } else if (o.tool_calls !== undefined || o.toolCallRequest !== undefined) {
      dbg("msg", `message[${index}] assistant tool call(s) were not normalizable; dropped`);
    }
  }

  if (role === "tool") {
    const id =
      (typeof o.tool_call_id === "string" && o.tool_call_id) ||
      (typeof o.toolCallId === "string" && o.toolCallId) ||
      (typeof o.call_id === "string" && o.call_id) ||
      `call_vb_t${index}`;
    out.tool_call_id = id;
  }

  return out;
}

/** Normalize a whole messages array to the official OpenAI wire format. */
export function normalizeOpenAIMessages(messages: unknown): OpenAIChatMessage[] {
  if (!Array.isArray(messages)) {
    warn("msg", "normalizeOpenAIMessages: input was not an array; returning []");
    return [];
  }
  const out: OpenAIChatMessage[] = [];
  messages.forEach((m, i) => {
    const n = normalizeOpenAIMessage(m, i);
    if (n) out.push(n);
  });
  return out;
}

/**
 * Diagnostic shape description of one outgoing message (for the pre-send
 * log). Identifies which message, if any, carries content as an object or
 * null — the signature behind LM Studio's
 * "messages ... must contain a 'content' field. Got 'object'" 400.
 * Values are safe to log (no base64 bodies; the logger redacts long strings).
 */
export function describeMessageShape(m: unknown, index: number): Record<string, unknown> {
  const o = (m && typeof m === "object" && !Array.isArray(m) ? m : {}) as Record<string, unknown>;
  const c = o.content;
  const desc: Record<string, unknown> = {
    index,
    role: typeof o.role === "string" ? o.role : `?(${typeof o.role})`,
    typeofContent: typeof c,
    isArray: Array.isArray(c),
  };
  if (Array.isArray(c)) {
    desc.partTypes = c.map((p) =>
      p && typeof p === "object"
        ? (typeof (p as Record<string, unknown>).type === "string"
            ? ((p as Record<string, unknown>).type as string)
            : `object:${Object.keys(p).slice(0, 6).join("/")}`)
        : typeof p
    );
  } else if (c !== null && c !== undefined && typeof c === "object") {
    desc.objectKeys = Object.keys(c).slice(0, 12);
  } else if (typeof c === "string") {
    desc.chars = c.length;
  }
  if (Array.isArray(o.tool_calls)) desc.toolCalls = (o.tool_calls as unknown[]).length;
  if (typeof o.tool_call_id === "string") desc.toolCallId = o.tool_call_id;
  return desc;
}

/** Normalize either LM style or OpenAI style tool call objects. */
export function normalizeToolCallAny(r: unknown, index: number): OpenAIToolCall | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const fn = o.function;
  if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
    const f = fn as Record<string, unknown>;
    const args = f.arguments;
    return {
      id: typeof o.id === "string" && o.id ? o.id : `call_vb_${index}`,
      type: "function",
      function: {
        name: f.name as string,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  }
  const name = typeof o.tool === "string" ? o.tool : typeof o.name === "string" ? o.name : null;
  if (!name) return null;
  const args = o.args ?? o.arguments ?? {};
  return {
    id: typeof o.id === "string" && o.id ? o.id : `call_vb_${index}`,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

export function extractAssistantToolCalls(m: AnyMessage, index: number): OpenAIToolCall[] {
  const out: OpenAIToolCall[] = [];
  const tcr = m?.toolCallRequest;
  if (tcr) {
    if (Array.isArray(tcr)) {
      tcr.forEach((tc, i) => {
        const n = normalizeToolCallAny(tc, index * 100 + i);
        if (n) out.push(n);
      });
    } else {
      const n = normalizeToolCallAny(tcr, index);
      if (n) out.push(n);
    }
  }
  const tcs = m?.tool_calls;
  if (Array.isArray(tcs)) {
    tcs.forEach((tc, i) => {
      const n = normalizeToolCallAny(tc, index * 100 + i + 1);
      if (n) out.push(n);
    });
  }
  return out;
}

/** Normalize tool definitions (LM or OpenAI style) for the API request. */
export function toOpenAITools(tools: unknown): OpenAIToolDef[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const defs: OpenAIToolDef[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (o.type === "function" && o.function && typeof o.function === "object") {
      const f = o.function as Record<string, unknown>;
      if (typeof f.name === "string") {
        defs.push({
          type: "function",
          function: {
            name: f.name,
            description: typeof f.description === "string" ? f.description : undefined,
            parameters: f.parameters ?? { type: "object", properties: {} },
          },
        });
      }
      continue;
    }
    if (typeof o.name === "string") {
      defs.push({
        type: "function",
        function: {
          name: o.name,
          description: typeof o.description === "string" ? o.description : undefined,
          parameters: o.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return defs.length > 0 ? defs : undefined;
}
