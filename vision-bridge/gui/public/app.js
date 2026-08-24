const $ = (id) => document.getElementById(id);
let latest = null;
let activeTab = "bridge";
let configLoaded = false;

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function ago(ts, now) { return ts ? `${fmtDuration(Math.max(0, now - ts))} ago` : "—"; }
function phaseLabel(p) {
  return ({ preparing:"PREPARING", connecting:"CONNECTING", connected:"CONNECTED", reasoning:"REASONING", generating:"GENERATING", tool_call:"TOOL CALL", completed:"COMPLETED", aborted:"ABORTED", error:"ERROR" })[p] || "NO REQUEST";
}
function isActive(p) { return ["preparing","connecting","connected","reasoning","generating","tool_call"].includes(p); }

function renderStatus(data) {
  latest = data;
  const r = data.runtime;
  const now = data.now || Date.now();
  if (!r) {
    $("phaseBadge").textContent = "NO REQUEST";
    $("phaseBadge").className = "badge idle";
    $("statusText").textContent = "Waiting for plugin…";
    $("statusNote").textContent = "LM Studioで一度Vision Bridgeを実行すると、ここに状態が表示されます。";
    $("pulse").className = "pulse";
    $("abortBtn").disabled = true;
  } else {
    const active = isActive(r.phase);
    const heartbeatAge = r.heartbeatAt ? now - r.heartbeatAt : Infinity;
    const heartbeatFresh = heartbeatAge < 3500;
    $("phaseBadge").textContent = phaseLabel(r.phase);
    $("phaseBadge").className = `badge ${r.phase === "error" || r.phase === "aborted" ? "error" : active ? (r.phase === "connected" ? "warn" : "active") : "idle"}`;
    $("pulse").className = `pulse ${heartbeatFresh && active ? "live" : active ? "dead" : r.phase === "error" ? "dead" : ""}`;
    const silent = r.lastModelActivityAt ? now - r.lastModelActivityAt : (r.requestStartedAt ? now - r.requestStartedAt : 0);
    let text = phaseLabel(r.phase);
    if (active && heartbeatFresh && silent > 30000) text += " · bridge alive, model stream quiet";
    if (active && !heartbeatFresh) text += " · heartbeat stale";
    $("statusText").textContent = text;
    $("statusNote").textContent = r.error || r.note || (r.phase === "connected" ? "HTTP接続済み。モデルからまだ可視ストリームが来ていません。" : "");
    $("abortBtn").disabled = !active;

    $("elapsed").textContent = fmtDuration(now - r.startedAt);
    $("lastActivity").textContent = ago(r.lastModelActivityAt, now);
    $("heartbeat").textContent = ago(r.heartbeatAt, now);
    $("reasoning").textContent = r.reasoningEvents ? `${r.reasoningEvents} events / ${r.reasoningChars || 0} chars` : "none observed";
    $("outputChars").textContent = `${r.textChars || 0} chars`;
    $("toolEvents").textContent = String(r.toolEvents || 0);
    $("activeModel").textContent = r.model || "—";
    $("activeApi").textContent = r.apiRoot || "—";
    $("activeTimeout").textContent = r.timeoutMs === 0 ? "disabled" : `${r.timeoutMs} ms`;
    $("workingDir").textContent = r.workingDirectory || "—";
    $("images").textContent = r.injectedImages?.length ? r.injectedImages.join(", ") : "none";
  }
  $("devState").textContent = data.dev?.state || "—";

  if (!configLoaded) {
    const c = data.config || {};
    $("model").value = c.model ?? "qwen/qwen3.8-27b";
    $("apiRoot").value = c.apiRoot ?? "http://127.0.0.1:1238";
    $("apiKey").value = c.apiKey ?? "";
    $("timeoutMs").value = c.timeoutMs ?? 0;
    $("bridgeEnabled").checked = c.bridgeEnabled ?? true;
    $("requoteOriginalRequest").checked = c.requoteOriginalRequest ?? true;
    $("logLevel").value = c.logLevel ?? "info";
    configLoaded = true;
  }
}

async function refreshStatus() {
  try {
    const r = await fetch("/api/status", { cache:"no-store" });
    renderStatus(await r.json());
  } catch (e) {
    $("statusText").textContent = `GUI error: ${e.message}`;
  }
}

async function refreshLog() {
  try {
    const endpoint = activeTab === "bridge" ? "/api/log" : "/api/dev-log";
    const r = await fetch(endpoint, { cache:"no-store" });
    const data = await r.json();
    const pre = $("logText");
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
    pre.textContent = data.text || "No log output yet.";
    $("logPath").textContent = activeTab === "bridge" ? (data.logFile || "Bridge log path not known yet") : `lms dev: ${data.state || "unknown"}`;
    if (nearBottom) pre.scrollTop = pre.scrollHeight;
  } catch {}
}

$("configForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const payload = {
    model: $("model").value.trim(), apiRoot: $("apiRoot").value.trim(), apiKey: $("apiKey").value,
    timeoutMs: Number($("timeoutMs").value || 0), bridgeEnabled: $("bridgeEnabled").checked,
    requoteOriginalRequest: $("requoteOriginalRequest").checked, logLevel: $("logLevel").value,
  };
  const res = await fetch("/api/config", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
  const data = await res.json();
  $("saveResult").textContent = res.ok ? "Saved. 次の推論から反映されます。" : (data.error || "Save failed");
  setTimeout(() => $("saveResult").textContent = "", 3500);
});

$("abortBtn").addEventListener("click", async () => {
  if (!confirm("現在のVision Bridgeリクエストを中断しますか？")) return;
  const res = await fetch("/api/abort", { method:"POST" });
  const data = await res.json();
  $("statusNote").textContent = res.ok ? "Abort requested…" : (data.error || "Abort failed");
});

$("resetDedupBtn").addEventListener("click", async () => {
  const res = await fetch("/api/reset-dedup", { method:"POST" });
  const data = await res.json();
  $("statusNote").textContent = res.ok ? "Seen-image state reset. 次の生成から同じ画像も再投入できます。" : (data.error || "Reset failed");
});

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); activeTab = b.dataset.tab; refreshLog();
}));

refreshStatus(); refreshLog();
setInterval(refreshStatus, 1000);
setInterval(refreshLog, 1500);
