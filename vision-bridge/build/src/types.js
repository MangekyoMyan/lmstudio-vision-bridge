/** Shared runtime types (prebuilt mirror of src/types.ts). */

export class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.detail = detail;
  }
}
