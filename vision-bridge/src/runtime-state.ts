/**
 * Cross-process runtime telemetry/control for the optional local GUI.
 *
 * The LM Studio plugin and the GUI are separate Node processes, so they share
 * only tiny JSON files under ~/.vision-bridge/.  No chat text, image bytes, or
 * API keys are written here.  The runtime file is diagnostic-only; failures to
 * read/write it must never break generation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimePhase =
  | "preparing"
  | "connecting"
  | "connected"
  | "reasoning"
  | "generating"
  | "tool_call"
  | "completed"
  | "aborted"
  | "error";

export interface RuntimeState {
  version: 1;
  invocationId: string;
  pid: number;
  phase: RuntimePhase;
  startedAt: number;
  updatedAt: number;
  heartbeatAt: number;
  requestStartedAt?: number;
  connectedAt?: number;
  lastNetworkActivityAt?: number;
  lastModelActivityAt?: number;
  model: string;
  apiRoot: string;
  transportMode?: "lmstudio" | "openai";
  timeoutMs: number;
  workingDirectory: string | null;
  logFile: string;
  messageCount: number;
  toolCount: number;
  injectedImages: string[];
  skippedImages: number;
  textChars: number;
  reasoningChars: number;
  reasoningEvents: number;
  toolEvents: number;
  finishReason?: string | null;
  note?: string;
  error?: string;
}

interface ControlState {
  abortInvocationId?: string;
  requestedAt?: number;
}

const APP_DIR = path.join(os.homedir(), ".vision-bridge");
const RUNTIME_FILE = path.join(APP_DIR, "runtime.json");
const CONTROL_FILE = path.join(APP_DIR, "control.json");

export function appStateDirectory(): string {
  return APP_DIR;
}

export function runtimeStateFile(): string {
  return RUNTIME_FILE;
}

export function controlStateFile(): string {
  return CONTROL_FILE;
}

function ensureDir(): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function atomicWriteJson(file: string, value: unknown): void {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows rename can fail when another process momentarily has the target
    // open. Fall back to a direct write; telemetry correctness is best-effort.
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function beginRuntime(
  initial: Omit<RuntimeState, "version" | "pid" | "updatedAt" | "heartbeatAt" | "textChars" | "reasoningChars" | "reasoningEvents" | "toolEvents">
): RuntimeState {
  const now = Date.now();
  const state: RuntimeState = {
    version: 1,
    pid: process.pid,
    updatedAt: now,
    heartbeatAt: now,
    textChars: 0,
    reasoningChars: 0,
    reasoningEvents: 0,
    toolEvents: 0,
    ...initial,
  };
  try { atomicWriteJson(RUNTIME_FILE, state); } catch { /* diagnostics must not break generation */ }
  return state;
}

export function patchRuntime(invocationId: string, patch: Partial<RuntimeState>): void {
  try {
    const current = readJson<RuntimeState>(RUNTIME_FILE);
    // A newer invocation may have started while an older request is winding
    // down. Never allow the older request to overwrite the newer status.
    if (!current || current.invocationId !== invocationId) return;
    const next: RuntimeState = {
      ...current,
      ...patch,
      invocationId,
      updatedAt: Date.now(),
    };
    atomicWriteJson(RUNTIME_FILE, next);
  } catch {
    /* diagnostics must not break generation */
  }
}

export function startRuntimeHeartbeat(invocationId: string, intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    patchRuntime(invocationId, { heartbeatAt: Date.now() });
  }, Math.max(250, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Poll the GUI control file for an abort request targeted at this invocation.
 * The returned disposer stops polling. The callback fires at most once.
 */
export function startAbortWatcher(invocationId: string, onAbort: () => void, intervalMs = 500): () => void {
  let fired = false;
  const poll = (): void => {
    if (fired) return;
    const control = readJson<ControlState>(CONTROL_FILE);
    if (control?.abortInvocationId !== invocationId) return;
    fired = true;
    try { fs.unlinkSync(CONTROL_FILE); } catch { /* GUI may rewrite it; harmless */ }
    onAbort();
  };
  poll();
  const timer = setInterval(poll, Math.max(200, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}
