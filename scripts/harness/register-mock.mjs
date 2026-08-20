// Registers the mock loader for the "lmstudio" module before any test file
// imports the generator. Run tests with:
//   node --import ./scripts/harness/register-mock.mjs <test>.mjs
import { register } from "node:module";

register(new URL("./loader-hooks.mjs", import.meta.url));

console.error("[harness] mock loader registered for 'lmstudio'");
