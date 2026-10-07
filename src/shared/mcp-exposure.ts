import type { McpExposure } from "../contract/mcp";
export type CanonicalMcpExposure = Exclude<McpExposure, "codemode-deferred">;
export function canonicalMcpExposure(value: McpExposure): CanonicalMcpExposure {
  return value === "codemode-deferred" ? "codemode" : value;
}
