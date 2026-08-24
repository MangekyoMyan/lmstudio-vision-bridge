// Config priority regression test.
// env > working-directory config > user config > defaults.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vb-home-"));
// os.homedir() consults HOME on POSIX and USERPROFILE on Windows.
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const { loadConfig } = await import("../../vision-bridge/build/src/config.js");

const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vb-config-wd-"));
fs.mkdirSync(path.join(fakeHome, ".vision-bridge"), { recursive: true });
fs.mkdirSync(path.join(wd, ".vision-bridge"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".vision-bridge", "config.json"), JSON.stringify({ model: "home-model", timeoutMs: 111 }));
fs.writeFileSync(path.join(wd, ".vision-bridge", "config.json"), JSON.stringify({ model: "working-model", timeoutMs: 222 }));

delete process.env.VISION_BRIDGE_MODEL;
delete process.env.VISION_BRIDGE_TIMEOUT_MS;
let failures = 0;
function check(ok, label, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; }

const fileCfg = loadConfig(wd);
check(fileCfg.model === "working-model", "working-directory config overrides user config", fileCfg.model);
check(fileCfg.timeoutMs === 222, "working-directory numeric config overrides user config", String(fileCfg.timeoutMs));

process.env.VISION_BRIDGE_MODEL = "env-model";
process.env.VISION_BRIDGE_TIMEOUT_MS = "0";
const envCfg = loadConfig(wd);
check(envCfg.model === "env-model", "environment overrides working-directory config", envCfg.model);
check(envCfg.timeoutMs === 0, "timeoutMs=0 is accepted as disabled", String(envCfg.timeoutMs));

delete process.env.VISION_BRIDGE_MODEL;
delete process.env.VISION_BRIDGE_TIMEOUT_MS;
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
