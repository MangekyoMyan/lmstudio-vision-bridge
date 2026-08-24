"use strict";
/**
 * Shared types (runtime + structural). No imports to avoid cycles.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeError = void 0;
class BridgeError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = "BridgeError";
    }
}
exports.BridgeError = BridgeError;
