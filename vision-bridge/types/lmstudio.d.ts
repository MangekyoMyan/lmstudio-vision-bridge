/**
 * Minimal ambient typings for the "lmstudio" plugin SDK module.
 *
 * At runtime the LM Studio plugin host injects the real implementation.
 * The exact surface can vary slightly between host versions, so the
 * runtime code (src/controller.ts, src/messages.ts, src/generator.ts)
 * probes for alternative method/property names instead of hard-coding
 * a single shape. Keep these typings permissive on purpose.
 */
declare module "lmstudio" {
  export type Role = "system" | "user" | "assistant" | "tool";

  export interface ToolCallRequest {
    id?: string;
    tool: string;
    args: Record<string, unknown>;
  }

  export interface ChatMessage {
    role: Role;
    content?: string | Array<Record<string, unknown>>;
    tool_call_id?: string;
    toolCallRequest?: ToolCallRequest | Array<ToolCallRequest>;
    tool_calls?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }

  export interface ModelInfo {
    id?: string;
    name?: string;
    [key: string]: unknown;
  }

  export class BaseController {
    getWorkingDirectory(): string;
    report_tool_call?(toolCall: ToolCallRequest): void;
    get_model_info?(): ModelInfo;
    [key: string]: unknown;
  }

  export class Generator {
    protected ctl: BaseController;
    constructor(ctl: BaseController);
    abstract generate(messages: ChatMessage[]): AsyncGenerator<string, void, unknown>;
  }
}
