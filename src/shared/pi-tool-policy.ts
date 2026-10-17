import { RpcError } from "../contract/types.ts";

/** The file format stays version 1; only explicit tool grants use this record revision. */
export const DESKTOP_TOOL_POLICY_REVISION = 2;
/** Unsupported model-facing tools must be absent from the non-Windows SDK registry. */
export const EXCLUDED_PI_TOOLS: readonly string[] = Object.freeze(["powershell"]);
export function excludedPiTools(platform?: string): readonly string[] {
  return platform === "win32" ? [] : EXCLUDED_PI_TOOLS;
}

export function filterDesktopToolNames(names: readonly string[], platform?: string): string[] {
  return [
    ...new Set(names.map((name) => name.trim()).filter((name) => name && !excludedPiTools(platform).includes(name))),
  ];
}

export function filterStoredToolNames(names: readonly string[], policyRevision: unknown, platform?: string): string[] {
  return filterDesktopToolNames(names, platform).filter(
    (name) => name !== "powershell" || policyRevision === DESKTOP_TOOL_POLICY_REVISION,
  );
}

/** Explicit requests fail before changing a session or persisting configuration. */
export function validateDesktopToolNames(value: unknown, platform?: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new RpcError({ code: "BAD_REQUEST", message: "toolNames must be an array of strings" });
  }
  if (value.some((name) => excludedPiTools(platform).includes(name.trim()))) {
    throw new RpcError({ code: "BAD_REQUEST", message: "The powershell Agent tool is not supported in Pi Desktop" });
  }
}
