// Phase 0: LM Studio OpenAI-compatible API reachability + loaded model check.
//
//   npm run api:smoke
//
// Exits 0 on success. Use VISION_BRIDGE_API_ROOT to point at another port
// (e.g. a fallback proxy or a second LM Studio instance).

const root = (process.env.VISION_BRIDGE_API_ROOT || "http://127.0.0.1:1238").replace(/\/+$/, "");
const key = process.env.VISION_BRIDGE_API_KEY || "lm-studio";
const modelsUrl = /\/v1$/i.test(root) ? `${root}/models` : `${root}/v1/models`;

async function main() {
  let res;
  try {
    res = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error(`FAIL cannot reach ${modelsUrl} — ${e.message}`);
    console.error("Hint: enable the LM Studio local server (default http://127.0.0.1:1238),");
    console.error("      or set VISION_BRIDGE_API_ROOT to the right endpoint.");
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`FAIL ${modelsUrl} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }

  const data = await res.json().catch(() => ({}));
  const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
  console.log(`API OK (HTTP ${res.status}) at ${root}`);
  console.log(`models: ${models.length > 0 ? models.join(", ") : "(no loaded model — load Qwen3.8-27B)"}`);

  const hasQwen = models.some((id) => /qwen/i.test(id));
  if (hasQwen) {
    console.log("qwen model present — ready for Phase 1+");
  } else {
    console.warn("WARN: no Qwen model in the list; Phase 1b/Phase 4 need Qwen3.8-27B loaded.");
  }
  process.exit(0);
}

main();
