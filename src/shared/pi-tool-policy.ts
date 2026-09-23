import { RpcError } from "../contract/types.ts";

/** Unsupported model-facing tools must be absent from the SDK registry, even after reload. */
export const EXCLUDED_PI_TOOLS: readonly string[] = Object.freeze(["powershell"]);

export function filterDesktopToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && !EXCLUDED_PI_TOOLS.includes(name)))];
}

/** Explicit requests fail before changing a session or persisting configuration. */
export function validateDesktopToolNames(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new RpcError({ code: "BAD_REQUEST", message: "toolNames must be an array of strings" });
  }
  if (value.some((name) => EXCLUDED_PI_TOOLS.includes(name.trim()))) {
    throw new RpcError({ code: "BAD_REQUEST", message: "The powershell Agent tool is not supported in Pi Desktop" });
  }
}
