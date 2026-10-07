import type { McpServerConfig } from "../contract/mcp";

/** Match the transport's authentication precedence without exposing credential values. */
export function mcpAuthenticationMode(
  config: Pick<McpServerConfig, "url" | "auth" | "headers">,
): "none" | "provider" | "header" | "oauth" {
  if (!config.url) return "none";
  if (config.auth) return "provider";
  return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization") ? "header" : "oauth";
}
