import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  McpOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  parseWwwAuthenticate,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "../../contract/mcp";
import { withLockedJsonFile } from "../../shared/node/locked-json-file";

/** Same URL keys, state shape, file lock and refresh lock names as the 0.99.1 CLI. */
export class McpOAuthStore {
  readonly filename: string;
  constructor(private readonly agentDir = getAgentDir()) {
    this.filename = path.join(agentDir, "mcp-auth.json");
  }
  forServer(serverUrl: string, signal?: AbortSignal): McpOAuthStateStore {
    const key = String(new URL(serverUrl));
    return {
      load: () =>
        withLockedJsonFile(
          this.filename,
          async (states) => {
            const state = states[key] as McpOAuthState | undefined;
            return state?.serverUrl === key ? state : undefined;
          },
          signal,
          { allowEmpty: true },
        ),
      save: async (state) => {
        if (state.serverUrl !== key) throw new Error("MCP OAuth state belongs to another server");
        await withLockedJsonFile(
          this.filename,
          async (states, save) => {
            states[key] = state;
            await save(states);
          },
          signal,
          { allowEmpty: true },
        );
      },
    };
  }
  async remove(serverUrl: string): Promise<void> {
    const key = String(new URL(serverUrl));
    await this.withRefreshLock(key, () =>
      withLockedJsonFile(
        this.filename,
        async (states, save) => {
          delete states[key];
          await save(states);
        },
        undefined,
        { allowEmpty: true },
      ),
    );
  }
  async withRefreshLock<T>(serverUrl: string, action: () => Promise<T>): Promise<T> {
    const key = String(new URL(serverUrl)),
      hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(path.join(this.agentDir, `mcp-auth-refresh-${hash}`), {
      realpath: false,
      stale: 20000,
      retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    try {
      if (compromised) throw compromised;
      const result = await action();
      if (compromised) throw compromised;
      return result;
    } finally {
      await release();
    }
  }
  provider(
    serverUrl: string,
    oauth: McpServerConfig["oauth"] = {},
    redirectUrl = "http://127.0.0.1/callback",
    onRedirect: (url: URL) => void | Promise<void> = () => {
      throw new McpOAuthAuthorizationRequiredError();
    },
    signal?: AbortSignal,
  ) {
    return new McpOAuthProvider({
      serverUrl,
      redirectUrl,
      clientMetadata: { client_name: "Pi Desktop" },
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      store: this.forServer(serverUrl, signal),
      onRedirect,
    });
  }
  authProvider(
    serverUrl: string,
    oauth: McpServerConfig["oauth"] = {},
    fetcher: McpFetch = globalThis.fetch,
  ): AuthProvider & { settled(): Promise<void> } {
    const store = this.forServer(serverUrl);
    let refreshing: Promise<void> | undefined;
    const refresh = (
      staleToken?: string,
      fetch: McpFetch = fetcher,
      resourceMetadataUrl?: URL,
      scope?: string,
    ): Promise<void> =>
      (refreshing ??= this.withRefreshLock(serverUrl, async () => {
        const state = await store.load();
        if (state?.tokens?.access_token !== staleToken) return;
        if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
        const registered = state.clientInformation as { redirect_uris?: string[] } | undefined;
        const redirect = oauth.callbackUrl ?? registered?.redirect_uris?.[0] ?? "http://127.0.0.1/callback";
        const provider = this.provider(serverUrl, oauth, redirect);
        const result = await authorizeMcp(provider, {
          serverUrl,
          resourceMetadataUrl,
          scope,
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
                : AbortSignal.timeout(15000),
            }),
        });
        if (result !== "AUTHORIZED") throw new McpOAuthAuthorizationRequiredError();
      }).finally(() => {
        refreshing = undefined;
      }));
    return {
      token: async () => {
        await refreshing?.catch(() => undefined);
        const state = await store.load();
        if (
          state?.tokensExpireAt !== undefined &&
          state.tokensExpireAt - 30000 <= Date.now() &&
          state.tokens?.refresh_token
        )
          await refresh(state.tokens.access_token).catch(() => undefined);
        return (await store.load())?.tokens?.access_token;
      },
      onUnauthorized: async (context) => {
        const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
        if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
        await refresh(context.token, context.fetch, challenge.resourceMetadataUrl, challenge.scope);
      },
      settled: async () => {
        await refreshing?.catch(() => undefined);
      },
    };
  }
}
