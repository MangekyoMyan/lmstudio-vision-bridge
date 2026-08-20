/**
 * Shared types (runtime + structural). No imports to avoid cycles.
 */

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAIPart = OpenAITextPart | OpenAIImagePart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

/** LM Studio-style tool call (what we report to the controller). */
export interface LsToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export type AnyMessage = Record<string, unknown>;
export type AnyController = Record<string, unknown>;

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
