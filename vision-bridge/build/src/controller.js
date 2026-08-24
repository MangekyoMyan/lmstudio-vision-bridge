"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkingDirectory = getWorkingDirectory;
exports.getControllerTools = getControllerTools;
exports.getModelInfo = getModelInfo;
exports.buildReportPayloads = buildReportPayloads;
exports.reportToolCall = reportToolCall;
/**
 * SDK adapter layer.
 *
 * The exact surface of the "lmstudio" host SDK can vary between versions, so
 * ALL controller interaction is centralized here. Each accessor probes a
 * small set of candidate names and logs which one succeeded, which makes
 * environment differences a one-line fix (add the name to the candidate list).
 */
const log_js_1 = require("./log.js");
/** "getWorkingDirectory" -> ["getWorkingDirectory", "get_working_directory"] etc. */
function candidateNames(base) {
    const out = [base];
    const camel = base.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    if (camel !== base)
        out.push(camel);
    const snake = base.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
    if (snake !== base)
        out.push(snake);
    return out;
}
function findMethod(ctl, base) {
    for (const name of candidateNames(base)) {
        const v = ctl[name];
        if (typeof v === "function")
            return v;
    }
    return null;
}
function getWorkingDirectory(ctl) {
    if (!ctl)
        return null;
    const fn = findMethod(ctl, "getWorkingDirectory");
    if (fn) {
        try {
            const v = fn.call(ctl);
            if (typeof v === "string" && v.length > 0) {
                (0, log_js_1.dbg)("ctl", `working directory via ctl.${fn.name || "method"}: ${v}`);
                return v;
            }
        }
        catch (e) {
            (0, log_js_1.warn)("ctl", "getWorkingDirectory() threw", String(e));
        }
    }
    for (const name of ["workingDirectory", "working_directory", "workDir"]) {
        const v = ctl[name];
        if (typeof v === "string" && v.length > 0)
            return v;
    }
    (0, log_js_1.warn)("ctl", "working directory not found on controller; falling back to process.cwd()");
    return null;
}
function getControllerTools(ctl) {
    if (!ctl)
        return null;
    for (const name of ["tools", "getTools", "toolDefinitions", "getToolDefinitions", "availableTools", "mcpTools"]) {
        const v = ctl[name];
        if (Array.isArray(v))
            return v;
        if (typeof v === "function") {
            try {
                const r = v.call(ctl);
                if (Array.isArray(r))
                    return r;
            }
            catch {
                /* try next candidate */
            }
        }
    }
    return null;
}
function getModelInfo(ctl) {
    if (!ctl)
        return null;
    for (const name of ["get_model_info", "getModelInfo", "modelInfo"]) {
        const v = ctl[name];
        if (v && typeof v === "object")
            return v;
        if (typeof v === "function") {
            try {
                const r = v.call(ctl);
                if (r && typeof r === "object")
                    return r;
            }
            catch {
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
function buildReportPayloads(toolCall) {
    let argsJson = "{}";
    try {
        argsJson = JSON.stringify(toolCall.args ?? {});
    }
    catch {
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
function reportToolCall(ctl, toolCall) {
    if (!ctl) {
        (0, log_js_1.err)("ctl", "no controller available — cannot report tool call", { id: toolCall.id, tool: toolCall.tool });
        return false;
    }
    const methods = Array.from(new Set([...REPORT_METHODS, ...candidateNames("report_tool_call")]));
    const payloads = buildReportPayloads(toolCall);
    for (const name of methods) {
        const v = ctl[name];
        if (typeof v !== "function")
            continue;
        for (const payload of payloads) {
            try {
                v.call(ctl, payload);
                (0, log_js_1.info)("ctl", `tool call reported via ctl.${name}`, {
                    id: toolCall.id,
                    tool: toolCall.tool,
                    payloadStyle: payload.tool !== undefined ? "lmstudio" : "openai",
                });
                return true;
            }
            catch (e) {
                (0, log_js_1.warn)("ctl", `ctl.${name} rejected the payload (trying next variant)`, {
                    error: String(e),
                    payloadStyle: payload.tool !== undefined ? "lmstudio" : "openai",
                });
            }
        }
    }
    (0, log_js_1.err)("ctl", "no working tool-call reporting method found on the controller", {
        availableKeys: Object.keys(ctl).slice(0, 80),
        hint: "add the real method name to REPORT_METHODS in src/controller.ts",
    });
    return false;
}
