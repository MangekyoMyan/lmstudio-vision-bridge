/**
 * Runtime configuration.
 *
 * Priority: environment variables > <working directory>/.vision-bridge/config.json
 *          > ~/.vision-bridge/config.json > defaults.
 *
 * `mode` controls only HOW Vision Bridge is exposed:
 *   - lmstudio: existing LM Studio Generator plugin path (default / backward compatible)
 *   - openai:   standalone OpenAI-compatible proxy for Open WebUI etc.
 *
 * The two modes deliberately keep separate upstream settings so switching
 * modes never overwrites the known-good LM Studio configuration.
 *
 * timeoutMs = 0 disables the absolute timeout. The optional GUI can still
 * abort the active request manually.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogLevel } from "./log.js";

export type BridgeMode = "lmstudio" | "openai";

export interface Config {
  mode: BridgeMode;

  /** Existing LM Studio Generator upstream settings. */
  apiRoot: string;
  apiKey: string;
  model: string;

  /** Standalone OpenAI-compatible proxy upstream settings. */
  openAiApiRoot: string;
  openAiApiKey: string;
  /** Empty = preserve the model id supplied by the client. Non-empty = force this upstream model. */
  openAiModel: string;

  /** Standalone OpenAI-compatible proxy listener settings. */
  proxyHost: string;
  proxyPort: number;
  /** API key expected from clients. Empty disables proxy authentication. */
  proxyApiKey: string;
  /** Optional base directory for relative image paths inside tool results. */
  proxyWorkingDirectory: string;

  timeoutMs: number;
  maxImageBytes: number;
  logLevel: LogLevel;
  logFile: string;
  bridgeEnabled: boolean;
  syntheticText: string;
  /** When true and the original pending user request can be extracted safely,
   *  the synthetic note re-quotes it verbatim (more robust model behavior).
   *  When false, only `syntheticText` is used. */
  requoteOriginalRequest: boolean;
}

const DEFAULT_SYNTHETIC_TEXT =
  "[Vision Bridge internal message]\n" +
  "This is not a new user request.\n" +
  "The attached image is the visual output returned by the immediately preceding MCP tool call.\n" +
  "Treat the attached image as part of that tool result.\n" +
  "Continue the existing user request using the visual information in this image.\n" +
  "Do not merely acknowledge, introduce, or describe the existence of the image.\n" +
  "Answer or continue the task that caused the tool to be called.";

function readJsonFile(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toLevel(v: string): LogLevel {
  const s = v.toLowerCase();
  return s === "debug" || s === "warn" || s === "error" ? (s as LogLevel) : "info";
}

function toMode(v: string): BridgeMode {
  const s = v.trim().toLowerCase();
  return s === "openai" || s === "openai_proxy" || s === "proxy" ? "openai" : "lmstudio";
}

export function loadConfig(workingDirectory?: string | null): Config {
  const fileCfg: Record<string, unknown> = {};
  // Merge LOW -> HIGH priority.
  const candidates = [
    path.join(os.homedir(), ".vision-bridge", "config.json"),
    workingDirectory ? path.join(workingDirectory, ".vision-bridge", "config.json") : null,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) {
    const j = readJsonFile(c);
    if (j) Object.assign(fileCfg, j);
  }

  const getStr = (key: string, envName: string, fallback: string): string => {
    const ev = process.env[envName];
    if (ev !== undefined && ev !== "") return ev;
    const fv = fileCfg[key];
    if (fv !== undefined && fv !== null && String(fv) !== "") return String(fv);
    return fallback;
  };
  const getPositiveNum = (key: string, envName: string, fallback: number): number => {
    const raw = getStr(key, envName, String(fallback));
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const getNonNegativeNum = (key: string, envName: string, fallback: number): number => {
    const raw = getStr(key, envName, String(fallback));
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const getBool = (key: string, envName: string, fallback: boolean): boolean => {
    const raw = getStr(key, envName, String(fallback));
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  };

  let logFile = getStr("logFile", "VISION_BRIDGE_LOG_FILE", "");
  if (!logFile) {
    const base = workingDirectory && workingDirectory.length > 0 ? workingDirectory : process.cwd();
    logFile = path.join(base, ".vision-bridge.log");
  }

  return {
    mode: toMode(getStr("mode", "VISION_BRIDGE_MODE", "lmstudio")),

    // Existing LM Studio settings are intentionally unchanged.
    apiRoot: getStr("apiRoot", "VISION_BRIDGE_API_ROOT", "http://127.0.0.1:1238").replace(/\/+$/, ""),
    apiKey: getStr("apiKey", "VISION_BRIDGE_API_KEY", "lm-studio"),
    model: getStr("model", "VISION_BRIDGE_MODEL", "qwen/qwen3.8-27b"),

    // Separate OpenAI-proxy upstream. Both "http://host:port" and
    // "http://host:port/v1" are accepted by the proxy.
    openAiApiRoot: getStr("openAiApiRoot", "VISION_BRIDGE_OPENAI_API_ROOT", "http://127.0.0.1:8080/v1").replace(/\/+$/, ""),
    openAiApiKey: getStr("openAiApiKey", "VISION_BRIDGE_OPENAI_API_KEY", ""),
    openAiModel: getStr("openAiModel", "VISION_BRIDGE_OPENAI_MODEL", ""),

    // 19281 is intentionally adjacent to the GUI's private 19280 port, while
    // staying far away from common AI ports such as 1234/3000/5000/7860/8000/8080.
    proxyHost: getStr("proxyHost", "VISION_BRIDGE_PROXY_HOST", "0.0.0.0"),
    proxyPort: getPositiveNum("proxyPort", "VISION_BRIDGE_PROXY_PORT", 19281),
    proxyApiKey: getStr("proxyApiKey", "VISION_BRIDGE_PROXY_API_KEY", "vision-bridge"),
    proxyWorkingDirectory: getStr("proxyWorkingDirectory", "VISION_BRIDGE_PROXY_WORKING_DIRECTORY", ""),

    // 0 = no absolute timeout. This avoids killing legitimate long reasoning
    // runs; the GUI/runtime telemetry makes the wait observable and abortable.
    timeoutMs: getNonNegativeNum("timeoutMs", "VISION_BRIDGE_TIMEOUT_MS", 0),
    maxImageBytes: getPositiveNum("maxImageBytes", "VISION_BRIDGE_MAX_IMAGE_BYTES", 20 * 1024 * 1024),
    logLevel: toLevel(getStr("logLevel", "VISION_BRIDGE_LOG_LEVEL", "info")),
    logFile,
    bridgeEnabled: getBool("bridgeEnabled", "VISION_BRIDGE_ENABLED", true),
    syntheticText: getStr("syntheticText", "VISION_BRIDGE_SYNTHETIC_TEXT", DEFAULT_SYNTHETIC_TEXT),
    requoteOriginalRequest: getBool("requoteOriginalRequest", "VISION_BRIDGE_REQUOTE_ORIGINAL_REQUEST", true),
  };
}
