import { OAuthCallbackServer, type McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type { McpServerConfig } from "../../contract/mcp";
import { mcpCallbackId } from "./oauth-identity";
import { validateMcpConfig } from "./config-store";

export function registeredMcpRedirects(state: McpOAuthState | undefined): string[] {
  const redirects = (state?.clientInformation as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  return Array.isArray(redirects) ? redirects.filter((value): value is string => typeof value === "string") : [];
}

/** Reuse a registered port when possible; an explicitly configured port never silently changes. */
export async function listenMcpCallback(
  serverUrl: string,
  oauth: McpServerConfig["oauth"],
  stored: McpOAuthState | undefined,
): Promise<OAuthCallbackServer> {
  validateMcpConfig("callback", { url: serverUrl, oauth });
  const configured = new URL(oauth?.callbackUrl ?? "http://127.0.0.1/callback");
  const host = configured.hostname.replace(/^\[|\]$/gu, "");
  const fixedPort = configured.port ? Number(configured.port) : oauth?.callbackPort;
  const registered = registeredMcpRedirects(stored)[0];
  const previousPort =
    registered && URL.canParse(registered) ? Number(new URL(registered).port) || undefined : undefined;
  const options = {
    host: host === "localhost" ? "127.0.0.1" : host,
    redirectHost: host,
    path: configured.pathname,
    extraPaths: oauth?.clientRegistration === "cimd" ? [`/callback/${mcpCallbackId(serverUrl)}`] : [],
    timeoutMs: 300000,
  };
  try {
    return await OAuthCallbackServer.listen({ ...options, port: fixedPort ?? previousPort });
  } catch (error) {
    if (fixedPort !== undefined || !previousPort || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return OAuthCallbackServer.listen(options);
  }
}
