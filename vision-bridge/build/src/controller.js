/**
 * SDK adapter layer (prebuilt mirror of src/controller.ts).
 * ALL controller interaction is centralized here; each accessor probes a
 * small set of candidate names and logs which one succeeded.
 */
import { dbg, err, info, warn } from "./log.js";

function candidateNames(base) {
  const out = [base];
  const camel = base.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  if (camel !== base) out.push(camel);
  const snake = base.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
  if (snake !== base) out.push(snake);
  return out;
}

function findMethod(ctl, base) {
  for (const name of candidateNames(base)) {
    const v = ctl[name];
    if (typeof v === "function") return v;
  }
  return null;
}

export function getWorkingDirectory(ctl) {
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

export function getControllerTools(ctl) {
  if (!ctl) return null;
  for (const name of ["tools", "getTools", "toolDefinitions", "getToolDefinitions", "availableTools", "mcpTools"]) {
    const v = ctl[name];
    if (Array.isArray(v)) return v;
    if (typeof v === "function") {
      try {
        const r = v.call(ctl);
        if (Array.isArray(r)) return r;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

export function getModelInfo(ctl) {
  if (!ctl) return null;
  for (const name of ["get_model_info", "getModelInfo", "modelInfo"]) {
    const v = ctl[name];
    if (v && typeof v === "object") return v;
    if (typeof v === "function") {
      try {
        const r = v.call(ctl);
        if (r && typeof r === "object") return r;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

export function buildReportPayloads(toolCall) {
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

export function reportToolCall(ctl, toolCall) {
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
        v.call(ctl, payload);
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
