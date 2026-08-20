// Mock loader hook: resolves the bare "lmstudio" import to our local mock,
// so the generator can be exercised OUTSIDE the LM Studio host (Phase 1-3
// logic tests). The host always injects the real module when the plugin runs
// inside LM Studio.
import { pathToFileURL } from "node:url";

const MOCKS = new Map([
  ["lmstudio", new URL("./mock-lmstudio.mjs", import.meta.url).href],
  // Current SDK name — mapped to the same mock so any runtime import of the
  // SDK under the harness stays hermetic (today all SDK imports in the
  // plugin are type-only and erased, so this is defensive future-proofing).
  ["@lmstudio/sdk", new URL("./mock-lmstudio.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const mock = MOCKS.get(specifier);
  if (mock) {
    return { url: mock, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
