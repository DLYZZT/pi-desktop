import { randomBytes, randomUUID } from "node:crypto";
import { authorizeMcp, type OAuthCallback, type OAuthCallbackServer } from "@earendil-works/pi-mcp/oauth";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { McpOAuthSnapshot, McpServerConfig, McpTarget } from "../../contract/mcp";
import { RpcError } from "../../contract/types";
import { mcpAuthenticationMode } from "../../shared/mcp-auth-mode";
import { safeChannelError } from "../channels/redaction";
import { resolveMcpValue } from "./connection";
import { validateMcpConfig } from "./config-store";
import { McpOAuthStore } from "./oauth-store";
import { listenMcpCallback, registeredMcpRedirects } from "./oauth-callback";
import { mcpCredentialKey, mergeMcpScopes } from "./oauth-identity";

export interface McpLoginInput {
  name: string;
  sessionId: string;
  cwd: string;
  trusted: boolean;
  config: McpServerConfig;
  target?: McpTarget;
}
interface PendingLogin {
  snapshot: McpOAuthSnapshot;
  input: McpLoginInput;
  controller: AbortController;
  commitController: AbortController;
  callback?: OAuthCallbackServer;
  manual: Promise<OAuthCallback>;
  submit: (value: OAuthCallback) => void;
  done: Promise<void>;
  committed: boolean;
}
export interface McpLoginOptions {
  updated: (snapshot: McpOAuthSnapshot) => void;
  openUrl?: (url: string) => Promise<void>;
  fetch?: McpFetch;
  validate?: (input: McpLoginInput) => Promise<void>;
}

/** Explicit sign-in only; one flow per credential identity across settings and sessions. */
export class McpOAuthLoginManager {
  private readonly requests = new Map<string, PendingLogin>();
  constructor(
    private readonly store: McpOAuthStore,
    private readonly options: McpLoginOptions,
  ) {}
  start(input: McpLoginInput): McpOAuthSnapshot {
    validateMcpConfig(input.name, input.config, input.target?.scope);
    if (!input.config.url) throw new RpcError({ code: "BAD_REQUEST", message: "MCP OAuth requires an HTTP server" });
    if (input.config.auth)
      throw new RpcError({
        code: "BAD_REQUEST",
        message: "This MCP server uses provider authentication; sign in through model settings",
      });
    if (mcpAuthenticationMode(input.config) !== "oauth")
      throw new RpcError({
        code: "BAD_REQUEST",
        message: "This MCP server uses an Authorization header; edit its authentication in server settings",
      });
    const identity = mcpCredentialKey(input.name, input.config.url);
    if (
      [...this.requests.values()].some(
        (item) => item.snapshot.state === "waiting" && this.identity(item.snapshot.requestId) === identity,
      )
    )
      throw new RpcError({ code: "CONFLICT", message: "MCP sign-in is already in progress for this server" });
    let submit!: (value: OAuthCallback) => void;
    const pending: PendingLogin = {
      snapshot: { requestId: randomUUID(), name: input.name, sessionId: input.sessionId, state: "waiting" },
      input: structuredClone(input),
      controller: new AbortController(),
      commitController: new AbortController(),
      manual: new Promise((resolve) => {
        submit = resolve;
      }),
      submit: (value) => submit(value),
      done: Promise.resolve(),
      committed: false,
    };
    this.requests.set(pending.snapshot.requestId, pending);
    pending.done = this.run(pending);
    return { ...pending.snapshot };
  }
  get(requestId: string): McpOAuthSnapshot {
    const pending = this.requests.get(requestId);
    if (!pending) throw new RpcError({ code: "NOT_FOUND", message: "MCP sign-in not found" });
    return { ...pending.snapshot };
  }
  identity(requestId: string): string | undefined {
    const input = this.requests.get(requestId)?.input;
    return input?.config.url ? mcpCredentialKey(input.name, input.config.url) : undefined;
  }
  async submit(requestId: string, value: string): Promise<McpOAuthSnapshot> {
    const pending = this.requests.get(requestId);
    if (!pending || pending.snapshot.state !== "waiting" || !pending.callback || !pending.snapshot.authUrl)
      throw new RpcError({ code: "CONFLICT", message: "MCP sign-in is not waiting for a callback" });
    const authUrl = new URL(pending.snapshot.authUrl),
      expectedState = authUrl.searchParams.get("state");
    let callback: URL;
    try {
      callback = new URL(value);
    } catch {
      throw new RpcError({ code: "BAD_REQUEST", message: "Expected the full MCP callback URL" });
    }
    const expected = new URL(authUrl.searchParams.get("redirect_uri") ?? pending.callback.redirectUrl);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.searchParams.get("state") !== expectedState ||
      !callback.searchParams.get("code")
    )
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP callback does not belong to this sign-in" });
    pending.submit({
      code: callback.searchParams.get("code")!,
      state: expectedState!,
      ...(callback.searchParams.has("iss") ? { iss: callback.searchParams.get("iss")! } : {}),
    });
    await pending.done;
    return { ...pending.snapshot };
  }
  async cancel(requestId: string): Promise<McpOAuthSnapshot> {
    const pending = this.requests.get(requestId);
    if (!pending) throw new RpcError({ code: "NOT_FOUND", message: "MCP sign-in not found" });
    if (pending.snapshot.state === "waiting") pending.controller.abort();
    await pending.done;
    return { ...pending.snapshot };
  }
  async cancelIdentity(name: string, url: string): Promise<void> {
    const key = mcpCredentialKey(name, url);
    for (const item of this.requests.values())
      if (item.snapshot.state === "waiting" && this.identity(item.snapshot.requestId) === key)
        item.commitController.abort();
    await this.cancelMatching((item) => this.identity(item.snapshot.requestId) === key);
  }
  async cancelSession(sessionId: string): Promise<void> {
    await this.cancelMatching((item) => item.snapshot.sessionId === sessionId);
  }
  async cancelInvalid(): Promise<void> {
    await Promise.all(
      [...this.requests.values()]
        .filter((item) => item.snapshot.state === "waiting")
        .map(async (item) => {
          try {
            await this.options.validate?.(item.input);
          } catch {
            item.commitController.abort();
            await this.cancel(item.snapshot.requestId);
          }
        }),
    );
  }
  async shutdown(): Promise<void> {
    await this.cancelMatching(() => true);
  }
  private async cancelMatching(matches: (item: PendingLogin) => boolean): Promise<void> {
    await Promise.all(
      [...this.requests.values()]
        .filter((item) => item.snapshot.state === "waiting" && matches(item))
        .map((item) => this.cancel(item.snapshot.requestId)),
    );
  }
  private async run(pending: PendingLogin): Promise<void> {
    const { name, config, cwd, trusted } = pending.input,
      signal = pending.controller.signal,
      serverUrl = config.url!;
    const timeout = setTimeout(() => pending.controller.abort(), 300000);
    try {
      await this.options.validate?.(pending.input);
      const oauth = { ...config.oauth };
      if (oauth.clientSecret) oauth.clientSecret = await resolveMcpValue(oauth.clientSecret, cwd, trusted);
      signal.throwIfAborted();
      const store = this.store.forServer(name, serverUrl, signal),
        stored = await store.load();
      const challenge = this.store.challenge(name, config);
      let scope: string | undefined;
      const flowState = randomBytes(32).toString("hex");
      pending.callback = await listenMcpCallback(serverUrl, oauth, stored);
      signal.throwIfAborted();
      await this.store.withRefreshLock(
        name,
        serverUrl,
        async () => {
          signal.throwIfAborted();
          const current = await store.load();
          scope = mergeMcpScopes(oauth.scope, current?.tokens?.scope, challenge?.scope);
          const next = { ...(current ?? { serverUrl: String(new URL(serverUrl)) }), oauthState: flowState };
          delete next.codeVerifier;
          const keepClient =
            oauth.clientId ||
            (oauth.clientRegistration === "cimd"
              ? !current?.clientInformation
              : registeredMcpRedirects(current).includes(pending.callback!.redirectUrl));
          if (!keepClient) {
            delete next.clientInformation;
            delete next.tokens;
            delete next.tokensExpireAt;
          }
          await store.save(next);
        },
        signal,
      );
      const provider = this.store.provider(
        name,
        serverUrl,
        oauth,
        pending.callback.redirectUrl,
        async (url) => {
          signal.throwIfAborted();
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Invalid MCP authorization URL");
          pending.snapshot.authUrl = url.href;
          this.publish(pending.snapshot);
          await this.options.openUrl?.(url.href);
        },
        signal,
        flowState,
      );
      // Once the code exchange starts, a cancelled UI must not discard a newly issued grant.
      provider.saveTokens = async (tokens) => {
        await this.store.commitAuthorization(name, serverUrl, tokens, flowState, pending.commitController.signal);
        pending.committed = true;
      };
      const fetcher =
        (exchange: boolean): McpFetch =>
        (input, init) =>
          (this.options.fetch ?? globalThis.fetch)(input, {
            ...init,
            signal: exchange
              ? AbortSignal.timeout(15000)
              : AbortSignal.any([signal, AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])]),
          });
      const flow = {
        serverUrl,
        scope,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        authorizationServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
      };
      const result = await authorizeMcp(provider, { ...flow, skipRefresh: true, fetch: fetcher(false) });
      if (result === "REDIRECT") {
        const authUrl = new URL(pending.snapshot.authUrl!),
          state = authUrl.searchParams.get("state");
        if (!state) throw new Error("MCP sign-in did not provide an OAuth state");
        const redirect = new URL(authUrl.searchParams.get("redirect_uri") ?? pending.callback.redirectUrl);
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("MCP sign-in cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        let callback: OAuthCallback;
        try {
          callback = await Promise.race([
            pending.callback.waitForCallback(state, redirect.pathname),
            pending.manual,
            cancelled,
          ]);
        } finally {
          signal.removeEventListener("abort", abort);
        }
        await this.store.withRefreshLock(
          name,
          serverUrl,
          async () => {
            await this.options.validate?.(pending.input);
            signal.throwIfAborted();
            if ((await store.load())?.oauthState !== callback.state)
              throw new Error("MCP sign-in was replaced by another flow");
            // Authorize using the current discovery result, including uncached configured metadata.
            // A signal-free provider finishes the exchange and its persisted tokens as one operation.
            const exchangeProvider = this.store.provider(
              name,
              serverUrl,
              oauth,
              pending.callback!.redirectUrl,
              undefined,
              pending.commitController.signal,
              flowState,
            );
            exchangeProvider.saveTokens = provider.saveTokens;
            const exchanged = await authorizeMcp(exchangeProvider, {
              ...flow,
              authorizationCode: callback.code,
              iss: callback.iss,
              fetch: fetcher(true),
            });
            if (exchanged !== "AUTHORIZED") throw new Error("MCP sign-in did not complete");
          },
          signal,
        );
      }
      if (!pending.committed) signal.throwIfAborted();
      this.store.clearChallenge(name, serverUrl);
      pending.snapshot.state = "succeeded";
    } catch (error) {
      pending.snapshot.state = pending.committed ? "succeeded" : signal.aborted ? "cancelled" : "failed";
      if (pending.snapshot.state === "failed") pending.snapshot.error = safeChannelError(error);
    } finally {
      clearTimeout(timeout);
      await pending.callback?.close().catch(() => undefined);
      delete pending.snapshot.authUrl;
      this.publish(pending.snapshot);
      const completed = [...this.requests.values()].filter((item) => item.snapshot.state !== "waiting");
      for (const item of completed.slice(0, Math.max(0, completed.length - 32)))
        this.requests.delete(item.snapshot.requestId);
    }
  }
  private publish(snapshot: McpOAuthSnapshot): void {
    try {
      this.options.updated({ ...snapshot });
    } catch {
      /* UI delivery does not change committed credentials. */
    }
  }
}
