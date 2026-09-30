import { randomUUID } from "node:crypto";
import { OAuthCallbackServer, authorizeMcp, type OAuthCallback } from "@earendil-works/pi-mcp/oauth";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { McpOAuthSnapshot, McpServerConfig } from "../../contract/mcp";
import { RpcError } from "../../contract/types";
import { safeChannelError } from "../channels/redaction";
import { resolveMcpValue } from "./connection";
import { McpOAuthStore } from "./oauth-store";

interface LoginInput {
  name: string;
  sessionId: string;
  cwd: string;
  trusted: boolean;
  config: McpServerConfig;
}
interface PendingLogin {
  snapshot: McpOAuthSnapshot;
  input: LoginInput;
  controller: AbortController;
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
}

/** Explicit sign-in only. Callback listeners and requests are scoped to a single cancellable login. */
export class McpOAuthLoginManager {
  private readonly requests = new Map<string, PendingLogin>();
  constructor(
    private readonly store: McpOAuthStore,
    private readonly options: McpLoginOptions,
  ) {}
  start(input: LoginInput): McpOAuthSnapshot {
    if (!input.config.url) throw new RpcError({ code: "BAD_REQUEST", message: "MCP OAuth requires an HTTP server" });
    if (
      [...this.requests.values()].some(
        (item) =>
          item.snapshot.sessionId === input.sessionId &&
          item.snapshot.name === input.name &&
          item.snapshot.state === "waiting",
      )
    )
      throw new RpcError({ code: "CONFLICT", message: "MCP sign-in is already in progress" });
    let submit!: (value: OAuthCallback) => void;
    const pending: PendingLogin = {
      snapshot: { requestId: randomUUID(), name: input.name, sessionId: input.sessionId, state: "waiting" },
      input: structuredClone(input),
      controller: new AbortController(),
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
  serverUrl(requestId: string): string | undefined {
    return this.requests.get(requestId)?.input.config.url;
  }
  async submit(requestId: string, value: string): Promise<McpOAuthSnapshot> {
    const pending = this.requests.get(requestId);
    if (!pending || pending.snapshot.state !== "waiting" || !pending.callback || !pending.snapshot.authUrl)
      throw new RpcError({ code: "CONFLICT", message: "MCP sign-in is not waiting for a callback" });
    const expectedState = new URL(pending.snapshot.authUrl).searchParams.get("state");
    let callback: URL;
    try {
      callback = new URL(value);
    } catch {
      throw new RpcError({ code: "BAD_REQUEST", message: "Expected the full MCP callback URL" });
    }
    const expected = new URL(pending.callback.redirectUrl);
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
      ...(callback.searchParams.get("iss") ? { iss: callback.searchParams.get("iss")! } : {}),
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
  async cancelSession(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.requests.values()]
        .filter((item) => item.snapshot.sessionId === sessionId && item.snapshot.state === "waiting")
        .map((item) => this.cancel(item.snapshot.requestId)),
    );
  }
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.requests.values()]
        .filter((item) => item.snapshot.state === "waiting")
        .map((item) => this.cancel(item.snapshot.requestId)),
    );
  }
  private async run(pending: PendingLogin): Promise<void> {
    const { config, cwd, trusted } = pending.input,
      signal = pending.controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      timeout = setTimeout(() => pending.controller.abort(), 300000);
      const oauth = { ...config.oauth };
      if (oauth.clientSecret) oauth.clientSecret = await resolveMcpValue(oauth.clientSecret, cwd, trusted);
      signal.throwIfAborted();
      const callbackUrl = new URL(oauth.callbackUrl ?? "http://127.0.0.1/callback"),
        host = callbackUrl.hostname.replace(/^\[|\]$/gu, "");
      pending.callback = await OAuthCallbackServer.listen({
        host: host === "localhost" ? "127.0.0.1" : host,
        redirectHost: host,
        port: callbackUrl.port ? Number(callbackUrl.port) : oauth.callbackPort,
        path: callbackUrl.pathname,
        timeoutMs: 300000,
      });
      signal.throwIfAborted();
      const provider = this.store.provider(
        config.url!,
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
      );
      const saveTokens = provider.saveTokens.bind(provider);
      provider.saveTokens = async (tokens) => {
        await saveTokens(tokens);
        pending.committed = true;
      };
      const fetcher: McpFetch = (input, init) =>
        (this.options.fetch ?? globalThis.fetch)(input, {
          ...init,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])]),
        });
      const result = await authorizeMcp(provider, {
        serverUrl: config.url!,
        scope: oauth.scope,
        skipRefresh: true,
        fetch: fetcher,
      });
      if (result === "REDIRECT") {
        const state = new URL(pending.snapshot.authUrl!).searchParams.get("state");
        if (!state) throw new Error("MCP sign-in did not provide an OAuth state");
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("MCP sign-in cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        let callback: OAuthCallback;
        try {
          callback = await Promise.race([pending.callback.waitForCallback(state), pending.manual, cancelled]);
        } finally {
          signal.removeEventListener("abort", abort);
        }
        const stored = await this.store.forServer(config.url!).load();
        const metadata = stored?.discovery?.authorizationServerMetadata,
          issuer = metadata?.issuer;
        if (metadata?.authorization_response_iss_parameter_supported === true && !callback.iss)
          throw new Error("MCP callback omitted its required issuer");
        if (callback.iss && callback.iss !== issuer) throw new Error("MCP callback issuer mismatch");
        signal.throwIfAborted();
        const exchanged = await authorizeMcp(provider, {
          serverUrl: config.url!,
          authorizationCode: callback.code,
          scope: oauth.scope,
          fetch: fetcher,
        });
        if (exchanged !== "AUTHORIZED") throw new Error("MCP sign-in did not complete");
      }
      if (!pending.committed) signal.throwIfAborted();
      pending.snapshot.state = "succeeded";
    } catch (error) {
      pending.snapshot.state = pending.committed ? "succeeded" : signal.aborted ? "cancelled" : "failed";
      if (pending.snapshot.state === "failed") pending.snapshot.error = safeChannelError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
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
