import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  McpOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  parseWwwAuthenticate,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthChallenge,
  type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "../../contract/mcp";
import { withLockedJsonFile } from "../../shared/node/locked-json-file";
import { mcpAuthConfiguration, mcpClientDocument, mcpCredentialKey, mergeMcpScopes } from "./oauth-identity";

type StoredChallenge = { configuration: string; challenge: OAuthChallenge; expiresAt: number };
const stateRevision = Symbol("MCP OAuth state revision");
const revision = (state: unknown) =>
  state === undefined ? "missing" : createHash("sha256").update(JSON.stringify(state)).digest("hex");

/** Pi 1.x name/URL keys and refresh locks, shared with the CLI. */
export class McpOAuthStore {
  readonly filename: string;
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly signedOut = new Map<string, symbol>();
  constructor(private readonly agentDir = getAgentDir()) {
    this.filename = path.join(agentDir, "mcp-auth.json");
  }
  forServer(name: string, serverUrl: string, signal?: AbortSignal, expectedState?: string): McpOAuthStateStore {
    const url = String(new URL(serverUrl)),
      key = mcpCredentialKey(name, url);
    let lastRead: string | undefined;
    const savedVersions = new WeakMap<object, string>();
    return {
      load: () =>
        withLockedJsonFile(
          this.filename,
          async (states, save) => {
            let state = states[key] as McpOAuthState | undefined;
            // Atomic first-reader adoption: another name at this URL must sign in separately.
            if (!state && states[url]) {
              const legacy = states[url] as McpOAuthState;
              if (legacy.serverUrl !== url) throw new Error("MCP OAuth state belongs to another server");
              state = legacy;
              states[key] = state;
              delete states[url];
              await save(states);
            }
            if (state && state.serverUrl !== url) throw new Error("MCP OAuth state belongs to another server");
            if (expectedState !== undefined && state?.oauthState !== expectedState)
              throw new Error("MCP sign-in was replaced or signed out");
            lastRead = revision(state);
            if (state) Object.defineProperty(state, stateRevision, { value: lastRead, enumerable: true });
            return state;
          },
          signal,
          { allowEmpty: true },
        ),
      save: async (state) => {
        if (state.serverUrl !== url) throw new Error("MCP OAuth state belongs to another server");
        await withLockedJsonFile(
          this.filename,
          async (states, save) => {
            if (expectedState !== undefined && (states[key] as McpOAuthState | undefined)?.oauthState !== expectedState)
              throw new Error("MCP sign-in was replaced or signed out");
            const expected =
              savedVersions.get(state) ??
              (state as McpOAuthState & { [stateRevision]?: string })[stateRevision] ??
              lastRead;
            if (expected !== undefined && revision(states[key]) !== expected)
              throw new Error("MCP OAuth state changed during this operation; retry sign-in");
            states[key] = state;
            await save(states);
            lastRead = revision(state);
            savedVersions.set(state, lastRead);
          },
          signal,
          { allowEmpty: true },
        );
      },
    };
  }
  async remove(name: string, serverUrl: string): Promise<void> {
    const url = String(new URL(serverUrl)),
      key = mcpCredentialKey(name, url);
    await this.withRefreshLock(name, url, () =>
      withLockedJsonFile(
        this.filename,
        async (states, save) => {
          const stored = Object.hasOwn(states, key) ? key : Object.hasOwn(states, url) ? url : undefined;
          if (!stored) return;
          delete states[stored];
          await save(states);
        },
        undefined,
        { allowEmpty: true },
      ),
    );
    this.signedOut.set(key, Symbol("signed-out"));
    this.clearChallenge(name, url);
  }
  /** Commit only the flow that still owns this slot; CLI logout or another login must win. */
  async commitAuthorization(
    name: string,
    serverUrl: string,
    tokens: OAuthTokens,
    state: string,
    signal: AbortSignal,
  ): Promise<void> {
    const key = mcpCredentialKey(name, serverUrl),
      url = String(new URL(serverUrl));
    await withLockedJsonFile(
      this.filename,
      async (states, save) => {
        const current = states[key] as McpOAuthState | undefined;
        if (!current || current.serverUrl !== url || current.oauthState !== state)
          throw new Error("MCP sign-in was replaced or signed out before its credentials could be saved");
        const next = { ...current, tokens };
        if (tokens.expires_in === undefined) delete next.tokensExpireAt;
        else next.tokensExpireAt = Date.now() + tokens.expires_in * 1000;
        states[key] = next;
        await save(states);
      },
      signal,
      { allowEmpty: true },
    );
  }
  async withRefreshLock<T>(
    name: string,
    serverUrl: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const hash = createHash("sha256").update(mcpCredentialKey(name, serverUrl)).digest("hex").slice(0, 16);
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    const deadline = Date.now() + 25000;
    while (!release) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(path.join(this.agentDir, "mcp-auth-refresh-" + hash), {
          realpath: false,
          stale: 20000,
          retries: 0,
          onCompromised: (error) => {
            compromised = error;
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
        await delay(100, undefined, { signal });
      }
    }
    try {
      if (compromised) throw compromised;
      const result = await action();
      if (compromised) throw compromised;
      return result;
    } finally {
      await release();
    }
  }
  challenge(name: string, config: McpServerConfig): OAuthChallenge | undefined {
    if (!config.url) return;
    const key = mcpCredentialKey(name, config.url),
      entry = this.challenges.get(key);
    if (!entry) return;
    if (entry.expiresAt < Date.now() || entry.configuration !== mcpAuthConfiguration(config)) {
      this.challenges.delete(key);
      return;
    }
    return {
      ...entry.challenge,
      resourceMetadataUrl: entry.challenge.resourceMetadataUrl
        ? new URL(entry.challenge.resourceMetadataUrl)
        : undefined,
    };
  }
  clearChallenge(name: string, serverUrl: string): void {
    this.challenges.delete(mcpCredentialKey(name, serverUrl));
  }
  private rememberChallenge(name: string, serverUrl: string, configuration: string, challenge: OAuthChallenge): void {
    const key = mcpCredentialKey(name, serverUrl),
      previous = this.challenges.get(key);
    if (previous?.configuration === configuration && previous.expiresAt > Date.now())
      challenge = {
        ...challenge,
        scope: mergeMcpScopes(previous.challenge.scope, challenge.scope),
        resourceMetadataUrl: challenge.resourceMetadataUrl ?? previous.challenge.resourceMetadataUrl,
      };
    if ((challenge.scope?.length ?? 0) > 16384 || (challenge.resourceMetadataUrl?.href.length ?? 0) > 8192)
      throw new Error("MCP OAuth challenge exceeds the supported size");
    this.challenges.set(mcpCredentialKey(name, serverUrl), {
      configuration,
      challenge,
      expiresAt: Date.now() + 300000,
    });
    if (this.challenges.size > 512) {
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
  }
  provider(
    name: string,
    serverUrl: string,
    oauth: McpServerConfig["oauth"] = {},
    redirectUrl = "http://127.0.0.1/callback",
    onRedirect: (url: URL) => void | Promise<void> = () => {
      throw new McpOAuthAuthorizationRequiredError();
    },
    signal?: AbortSignal,
    expectedState?: string,
  ) {
    return new McpOAuthProvider({
      serverUrl,
      redirectUrl,
      clientMetadata: { client_name: oauth.clientName ?? "Pi Desktop" },
      clientMetadataDocument:
        oauth.clientRegistration === "cimd"
          ? (metadata) => mcpClientDocument(serverUrl, redirectUrl, metadata)
          : undefined,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      store: this.forServer(name, serverUrl, signal, expectedState),
      onRedirect,
    });
  }
  authProvider(
    name: string,
    serverUrl: string,
    oauth: McpServerConfig["oauth"] = {},
    fetcher: McpFetch = globalThis.fetch,
    configuration = mcpAuthConfiguration({ url: serverUrl, oauth }),
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): AuthProvider & { settled(): Promise<void> } {
    const store = this.forServer(name, serverUrl);
    const key = mcpCredentialKey(name, serverUrl),
      generation = this.signedOut.get(key);
    const assertCurrent = () => {
      if (!isCurrent() || this.signedOut.get(key) !== generation) throw new McpOAuthAuthorizationRequiredError();
    };
    let refreshing: Promise<void> | undefined;
    const refresh = (
      staleToken?: string,
      fetch: McpFetch = fetcher,
      resourceMetadataUrl?: URL,
      scope?: string,
    ): Promise<void> =>
      (refreshing ??= this.withRefreshLock(
        name,
        serverUrl,
        async () => {
          const state = await store.load();
          assertCurrent();
          if (state?.tokens?.access_token !== staleToken) return;
          if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
          const registered = state.clientInformation as { redirect_uris?: string[] } | undefined;
          const redirect = oauth.callbackUrl ?? registered?.redirect_uris?.[0] ?? "http://127.0.0.1/callback";
          const provider = this.provider(name, serverUrl, oauth, redirect);
          const refreshSignal = AbortSignal.timeout(15000);
          const result = await authorizeMcp(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope,
            authorizationServerMetadataUrl: oauth.authServerMetadataUrl
              ? new URL(oauth.authServerMetadataUrl)
              : undefined,
            // A started refresh may rotate the token; allow its response to be persisted before shutdown.
            fetch: (input, init) => fetch(input, { ...init, signal: refreshSignal }),
          });
          if (result !== "AUTHORIZED") throw new McpOAuthAuthorizationRequiredError();
        },
        signal,
      ).finally(() => {
        refreshing = undefined;
      }));
    return {
      token: async () => {
        assertCurrent();
        await refreshing?.catch(() => undefined);
        const state = await store.load();
        if (
          state?.tokensExpireAt !== undefined &&
          state.tokensExpireAt - 30000 <= Date.now() &&
          state.tokens?.refresh_token
        )
          await refresh(state.tokens.access_token).catch(() => undefined);
        const token = (await store.load())?.tokens?.access_token;
        assertCurrent();
        return token;
      },
      onUnauthorized: async (context) => {
        const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
        const current = (await store.load())?.tokens?.access_token;
        assertCurrent();
        if (current !== undefined && current !== context.token) return;
        this.rememberChallenge(name, serverUrl, configuration, challenge);
        if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
        await refresh(context.token, context.fetch, challenge.resourceMetadataUrl, challenge.scope);
      },
      settled: async () => {
        await refreshing?.catch(() => undefined);
      },
    };
  }
}
