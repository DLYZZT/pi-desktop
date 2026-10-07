import { createHash } from "node:crypto";
import type { AuthorizationServerMetadata, OAuthClientMetadataDocument } from "@earendil-works/pi-mcp/oauth";
import type { McpServerConfig } from "../../contract/mcp";

export function mcpNamespace(name: string): string {
  return "mcp__" + name.replace(/[^A-Za-z0-9_]/gu, "_");
}

/** Pi 1.x credential identity; the original server name remains available to the UI. */
export function mcpCredentialKey(name: string, url: string): string {
  return `mcp__${name.replace(/-/gu, "_")}|${String(new URL(url))}`;
}

/** A challenge or pending login must not cross a server configuration change. */
export function mcpAuthConfiguration(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function mcpCallbackId(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/** Same Pi CIMD documents and server-bound callback paths as the 1.0.4 CLI. */
export function mcpClientDocument(
  serverUrl: string,
  redirectUrl: string,
  metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
  if (
    !metadata?.client_id_metadata_document_supported ||
    !metadata.token_endpoint_auth_methods_supported?.includes("none")
  )
    throw new Error("The authorization server does not support Client ID Metadata Documents for public clients");
  if (metadata.authorization_response_iss_parameter_supported)
    return { url: "https://pi.dev/oauth/client.json", redirectUrl };
  const id = mcpCallbackId(serverUrl),
    redirect = new URL(redirectUrl);
  redirect.pathname = `/callback/${id}`;
  return { url: `https://pi.dev/oauth/${id}/client.json`, redirectUrl: redirect.href };
}

export function mergeMcpScopes(...values: (string | undefined)[]): string | undefined {
  const result = [...new Set(values.flatMap((value) => value?.split(/\s+/u).filter(Boolean) ?? []))].join(" ");
  return result || undefined;
}
