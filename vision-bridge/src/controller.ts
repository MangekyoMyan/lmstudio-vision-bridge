/**
 * SDK adapter layer.
 *
 * The exact surface of the "lmstudio" host SDK can vary between versions, so
 * ALL controller interaction is centralized here. Each accessor probes a
 * small set of candidate names and logs which one succeeded, which makes
 * environment differences a one-line fix (add the name to the candidate list).
 */
import { dbg, err, info, warn } from "./log.js";
import type { AnyController, LsToolCall } from "./types.js";

/** "getWorkingDirectory" -> ["getWorkingDirectory", "get_working_directory"] etc. */
function candidateNames(base: string): string[] {
  const out = [base];
  const camel = base.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  if (camel !== base) out.push(camel);
  const snake = base.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
  if (snake !== base) out.push(snake);
  return out;
}

function findMethod(ctl: AnyController, base: string): ((...args: unknown[]) => unknown) | null {
  for (const name of candidateNames(base)) {
    const v = ctl[name];
    if (typeof v === "function") return v as (...args: unknown[]) => unknown;
  }
  return null;
}

export function getWorkingDirectory(ctl: AnyController | null | undefined): string | null {
  if (!ctl) return null;
  const fn = findMethod(ctl, "getWorkingDirectory");
  if (fn) {
    try {
      const v = fn.call(ctl);
      if (typeof v === "string" && v.length > 0) {
        dbg("ctl", `working directory via ctl.${fn.name || "method"}: ${v}`);
        return v;
      }
    } catch (e) {
      warn("ctl", "getWorkingDirectory() threw", String(e));
    }
  }
  for (const name of ["workingDirectory", "working_directory", "workDir"]) {
    const v = ctl[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  warn("ctl", "working directory not found on controller; falling back to process.cwd()");
  return null;
}

export function getControllerTools(ctl: AnyController | null | undefined): unknown[] | null {
  if (!ctl) return null;
  for (const name of ["tools", "getTools", "toolDefinitions", "getToolDefinitions", "availableTools", "mcpTools"]) {
    const v = ctl[name];
    if (Array.isArray(v)) return v;
    if (typeof v === "function") {
      try {
        const r = (v as () => unknown).call(ctl);
        if (Array.isArray(r)) return r;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

export function getModelInfo(ctl: AnyController | null | undefined): Record<string, unknown> | null {
  if (!ctl) return null;
  for (const name of ["get_model_info", "getModelInfo", "modelInfo"]) {
    const v: unknown = ctl[name];
    if (v && typeof v === "object") return v as Record<string, unknown>;
    if (typeof v === "function") {
      try {
        const r = (v as () => unknown).call(ctl);
        if (r && typeof r === "object") return r as Record<string, unknown>;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

/**
 * Payload shapes tried when reporting a tool call to LM Studio.
 * LM Studio style first (matches the official openai-compat-endpoint
 * conversion), OpenAI style as a fallback.
 */
export function buildReportPayloads(toolCall: LsToolCall): Array<Record<string, unknown>> {
  let argsJson = "{}";
  try {
    argsJson = JSON.stringify(toolCall.args ?? {});
  } catch {
    argsJson = "{}";
  }
  return [
    { id: toolCall.id, tool: toolCall.tool, args: toolCall.args ?? {} },
    { id: toolCall.id, type: "function", function: { name: toolCall.tool, arguments: argsJson } },
  ];
}

const REPORT_METHODS = [
  "report_tool_call",
  "reportToolCall",
  "emit_tool_call",
  "emitToolCall",
  "notify_tool_call",
  "request_tool_call",
];

/**
 * Report a tool call to LM Studio so that the host executes the MCP tool.
 * Returns true on success. NEVER executes the tool itself.
 */
export function reportToolCall(ctl: AnyController | null | undefined, toolCall: LsToolCall): boolean {
  if (!ctl) {
    err("ctl", "no controller available — cannot report tool call", { id: toolCall.id, tool: toolCall.tool });
    return false;
  }
  const methods = Array.from(new Set([...REPORT_METHODS, ...candidateNames("report_tool_call")]));
  const payloads = buildReportPayloads(toolCall);
  for (const name of methods) {
    const v = ctl[name];
    if (typeof v !== "function") continue;
    for (const payload of payloads) {
      try {
        (v as (p: unknown) => void).call(ctl, payload);
        info("ctl", `tool call reported via ctl.${name}`, {
          id: toolCall.id,
          tool: toolCall.tool,
          payloadStyle: payload.tool !== undefined ? "lmstudio" : "openai",
        });
        return true;
      } catch (e) {
        warn("ctl", `ctl.${name} rejected the payload (trying next variant)`, {
          error: String(e),
          payloadStyle: payload.tool !== undefined ? "lmstudio" : "openai",
        });
      }
    }
  }
  err("ctl", "no working tool-call reporting method found on the controller", {
    availableKeys: Object.keys(ctl).slice(0, 80),
    hint: "add the real method name to REPORT_METHODS in src/controller.ts",
  });
  return false;
}
