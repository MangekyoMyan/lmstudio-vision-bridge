/**
 * Runtime configuration.
 *
 * Priority: environment variables > <working directory>/.vision-bridge/config.json
 *          > ~/.vision-bridge/config.json > defaults.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogLevel } from "./log.js";

export interface Config {
  apiRoot: string;
  apiKey: string;
  model: string;
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

export function loadConfig(workingDirectory?: string | null): Config {
  const fileCfg: Record<string, unknown> = {};
  const candidates = [
    workingDirectory ? path.join(workingDirectory, ".vision-bridge", "config.json") : null,
    path.join(os.homedir(), ".vision-bridge", "config.json"),
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
  const getNum = (key: string, envName: string, fallback: number): number => {
    const raw = getStr(key, envName, String(fallback));
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
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
    apiRoot: getStr("apiRoot", "VISION_BRIDGE_API_ROOT", "http://127.0.0.1:1238").replace(/\/+$/, ""),
    apiKey: getStr("apiKey", "VISION_BRIDGE_API_KEY", "lm-studio"),
    model: getStr("model", "VISION_BRIDGE_MODEL", "qwen/qwen3.8-27b"),
    timeoutMs: getNum("timeoutMs", "VISION_BRIDGE_TIMEOUT_MS", 300000),
    maxImageBytes: getNum("maxImageBytes", "VISION_BRIDGE_MAX_IMAGE_BYTES", 20 * 1024 * 1024),
    logLevel: toLevel(getStr("logLevel", "VISION_BRIDGE_LOG_LEVEL", "info")),
    logFile,
    bridgeEnabled: getBool("bridgeEnabled", "VISION_BRIDGE_ENABLED", true),
    syntheticText: getStr("syntheticText", "VISION_BRIDGE_SYNTHETIC_TEXT", DEFAULT_SYNTHETIC_TEXT),
    requoteOriginalRequest: getBool("requoteOriginalRequest", "VISION_BRIDGE_REQUOTE_ORIGINAL_REQUEST", true),
  };
}
