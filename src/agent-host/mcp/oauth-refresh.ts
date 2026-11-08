import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  McpOAuthAuthorizationRequiredError,
  OAuthInsecureEndpointError,
  refreshAuthorization,
  selectResource,
  type McpOAuthState,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "../../contract/mcp";
import { mcpClientDocument } from "./oauth-identity";

export interface McpRefreshResult {
  tokens: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

/** Refresh an existing grant only: no registration, PKCE, redirect or storage mutation. */
export async function refreshMcpGrant(
  serverUrl: string,
  oauth: NonNullable<McpServerConfig["oauth"]>,
  state: McpOAuthState,
  fetch: McpFetch,
  signal: AbortSignal,
  resourceMetadataUrl?: URL,
): Promise<McpRefreshResult> {
  signal.throwIfAborted();
  if (!state.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
  const metadataUrl = oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined;
  if (
    metadataUrl &&
    metadataUrl.protocol !== "https:" &&
    !(metadataUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(metadataUrl.hostname))
  )
    throw new OAuthInsecureEndpointError(metadataUrl.href);
  // A configured metadata document bypasses the cache, as it does for interactive authorization.
  const cached = metadataUrl ? undefined : state.discovery;
  const discovery = cached?.authorizationServerUrl
    ? {
        authorizationServerUrl: cached.authorizationServerUrl,
        authorizationServerMetadata:
          cached.authorizationServerMetadata ??
          (await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, { fetch, signal })),
        resourceMetadata: cached.resourceMetadata,
      }
    : await discoverOAuthServerInfo(serverUrl, {
        authorizationServerMetadataUrl: metadataUrl,
        resourceMetadataUrl,
        fetch,
        signal,
      });
  signal.throwIfAborted();
  let client = oauth.clientId
    ? { client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) }
    : state.clientInformation;
  if (!client) {
    // CLI CIMD grants have no stored registration. Keep their original identity even when
    // Desktop would choose DCR for a new sign-in; a refresh must never register another client.
    const document = mcpClientDocument(
      serverUrl,
      oauth.callbackUrl ?? "http://127.0.0.1/callback",
      discovery.authorizationServerMetadata,
    );
    client = { client_id: document.url };
  }
  const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata,
    clientInformation: client,
    resource: selectResource(serverUrl, discovery.resourceMetadata),
    refreshToken: state.tokens.refresh_token,
    fetch,
    signal,
  });
  return {
    tokens: tokens.scope === undefined && state.tokens.scope ? { ...tokens, scope: state.tokens.scope } : tokens,
    ...(!metadataUrl && {
      discovery: { ...discovery, ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}) },
    }),
  };
}
