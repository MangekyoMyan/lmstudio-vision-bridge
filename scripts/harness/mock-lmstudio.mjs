// Minimal in-memory mock of the "lmstudio" plugin SDK, matching the surface
// the generator uses. Lets us drive the generator outside LM Studio.
//
// - BaseController: working directory + report_tool_call() capture
// - Generator: base class with a `ctl` member
//
// Real host behavior (tool execution, MCP) is intentionally NOT simulated —
// those stay with LM Studio. We only capture the tool call the generator
// reports so a test can assert it happened and then feed the next history.

export class BaseController {
  constructor({ workingDirectory = process.cwd(), tools = [], modelInfo = { id: "qwen3.8-27b", name: "Qwen3.8-27B" } } = {}) {
    this.__workingDirectory = workingDirectory;
    this.tools = tools;
    this.__modelInfo = modelInfo;
    this.reportedToolCalls = [];
  }

  getWorkingDirectory() {
    return this.__workingDirectory;
  }

  report_tool_call(toolCall) {
    this.reportedToolCalls.push(toolCall);
  }

  get_model_info() {
    return this.__modelInfo;
  }
}

export class Generator {
  constructor(ctl) {
    this.ctl = ctl;
  }

  generate() {
    throw new Error("Generator.generate() not implemented");
  }
}

export class ChatMessage {}

export default {
  BaseController,
  Generator,
  ChatMessage,
};
