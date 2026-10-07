import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  McpClient,
  StreamableHttpTransport,
  McpAuthRequiredError,
  type McpTransport,
  type Tool,
  type McpFetch,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { McpInstanceSnapshot, McpServerConfig } from "../../contract/mcp";
import { toolchainRuntime, type ToolchainRuntime } from "../toolchain-runtime";
import { readPiRuntimeVersion } from "../runtime-version";
import { safeChannelError } from "../channels/redaction";
import { ContainedMcpStdioTransport } from "./stdio-transport";
import { McpOAuthStore } from "./oauth-store";
import { validateMcpConfig } from "./config-store";
import { mcpAuthConfiguration } from "./oauth-identity";
import { mcpAuthenticationMode } from "../../shared/mcp-auth-mode";

export async function resolveMcpValue(
  value: string,
  cwd: string,
  trusted: boolean,
  runtime: ToolchainRuntime = toolchainRuntime,
): Promise<string> {
  if (value.startsWith("!")) {
    const { stdout } = await runtime.exec("shell.bash", ["-c", value.slice(1)], {
      cwd,
      trusted,
      intent: "managed-process",
      timeout: 15000,
      maxBuffer: 32768,
    });
    return stdout.trim();
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    if (process.env[name] === undefined) throw new Error(`MCP environment variable ${name} is not set`);
    return process.env[name]!;
  });
}
export async function resolveMcpMap(
  values: Record<string, string> | undefined,
  cwd: string,
  trusted: boolean,
  runtime?: ToolchainRuntime,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(values ?? {}).map(
      async ([key, value]) => [key, await resolveMcpValue(value, cwd, trusted, runtime)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export interface McpConnectionOptions {
  snapshot: McpInstanceSnapshot;
  config: McpServerConfig;
  trusted: boolean;
  credentials?: McpOAuthStore;
  runtime?: ToolchainRuntime;
  fetch?: McpFetch;
  providerToken?: (provider: string) => Promise<string | undefined>;
  createTransport?: (config: McpServerConfig, cwd: string) => McpTransport | Promise<McpTransport>;
  changed: (connection: McpConnection) => void;
}

/** One generation of one server in one session. Closing never replays a failed tool request. */
export class McpConnection {
  readonly client: McpClient;
  readonly config: McpServerConfig;
  readonly snapshot: McpInstanceSnapshot;
  tools: Tool[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private connecting?: Promise<void>;
  private transport?: McpTransport;
  private auth?: ReturnType<McpOAuthStore["authProvider"]>;
  private readonly controller = new AbortController();
  constructor(private readonly options: McpConnectionOptions) {
    validateMcpConfig(options.snapshot.name, options.config, options.snapshot.scope);
    this.config = structuredClone(options.config);
    this.snapshot = { ...options.snapshot };
    this.client = new McpClient({
      name: "pi-desktop",
      version: readPiRuntimeVersion(),
      requestTimeoutMs: (this.config.timeout ?? 60) * 1000,
      capabilities: { roots: { listChanged: false } },
      roots: () => [{ uri: pathToFileURL(this.snapshot.cwd).href }],
    });
    this.client.onClose(() => {
      if (!this.closed && (this.snapshot.state === "connecting" || this.snapshot.state === "connected"))
        this.state("disconnected");
    });
    this.client.onNotification("notifications/tools/list_changed", () => {
      void this.refreshTools().catch((error) => this.state("failed", error));
    });
  }
  start(): Promise<void> {
    return (this.connecting ??= this.connect());
  }
  private async connect(): Promise<void> {
    if (this.config.enabled === false) {
      this.state("disabled");
      return;
    }
    this.state("connecting");
    try {
      const cwd = this.snapshot.cwd;
      if (this.options.createTransport) this.transport = await this.options.createTransport(this.config, cwd);
      else if (this.config.url) {
        const headers = await resolveMcpMap(this.config.headers, cwd, this.options.trusted, this.options.runtime);
        const oauth = { ...this.config.oauth };
        if (oauth.clientSecret)
          oauth.clientSecret = await resolveMcpValue(
            oauth.clientSecret,
            cwd,
            this.options.trusted,
            this.options.runtime,
          );
        if (this.config.auth) {
          const provider = this.config.auth.provider;
          this.auth = {
            token: async () => {
              const token = await this.options.providerToken?.(provider);
              if (!token) {
                const error = new McpOAuthAuthorizationRequiredError();
                error.message = "Sign in to " + provider + " through model settings";
                throw error;
              }
              return token;
            },
            settled: async () => {},
          };
        } else if (mcpAuthenticationMode(this.config) === "oauth") {
          this.auth = (this.options.credentials ?? new McpOAuthStore()).authProvider(
            this.snapshot.name,
            this.config.url,
            oauth,
            this.options.fetch,
            mcpAuthConfiguration(this.config),
            () => !this.closed && !this.snapshot.pendingApply,
            this.controller.signal,
          );
        }
        const auth = this.auth;
        if (auth) {
          this.auth = {
            ...auth,
            token: async () => {
              try {
                return await auth.token();
              } catch (error) {
                this.authenticationRequired(error);
                throw error;
              }
            },
            onUnauthorized: async (context) => {
              try {
                if (auth.onUnauthorized) return await auth.onUnauthorized(context);
                const token = await auth.token();
                if (token && token !== context.token) return;
                throw new McpOAuthAuthorizationRequiredError();
              } catch (error) {
                this.authenticationRequired(error);
                throw error;
              }
            },
          };
        }
        this.transport = new StreamableHttpTransport({
          url: this.config.url,
          headers,
          authProvider: this.auth,
          fetch: this.options.fetch,
        });
      } else {
        this.transport = new ContainedMcpStdioTransport({
          config: this.config,
          cwd: this.config.cwd ? path.resolve(cwd, this.config.cwd) : cwd,
          trusted: this.options.trusted,
          runtime: this.options.runtime,
          env: await resolveMcpMap(this.config.env, cwd, this.options.trusted, this.options.runtime),
          onStderr: (text) => {
            this.snapshot.diagnostics = [...(this.snapshot.diagnostics ?? []), text].slice(-8);
            this.options.changed(this);
          },
        });
      }
      this.controller.signal.throwIfAborted();
      await this.client.connect(this.transport);
      this.controller.signal.throwIfAborted();
      await this.refreshTools();
      this.state("connected");
    } catch (error) {
      if (!this.closed)
        this.state(
          error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError
            ? "needs-auth"
            : "failed",
          error,
        );
      await this.client.close().catch(() => undefined);
      await this.transport?.close().catch(() => undefined);
      if (!this.closed) throw error;
    }
  }
  authenticationRequired(error: unknown): void {
    if (!this.closed && (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError))
      this.state("needs-auth", error);
  }
  async refreshTools(): Promise<void> {
    if (this.closed) return;
    const tools = this.client.serverCapabilities?.tools
      ? await this.client.listTools({ signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]) })
      : [];
    if (this.closed) return;
    if (
      tools.length > 5000 ||
      tools.some((tool) => tool.name.length > 512 || JSON.stringify(tool.inputSchema).length > 65536)
    )
      throw new Error("MCP tool catalog exceeds the read budget");
    this.tools = tools;
    this.snapshot.toolCount = tools.length;
    this.options.changed(this);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.controller.abort();
      await this.client.close();
      await this.transport?.close();
      await this.auth?.settled();
      this.tools = [];
      this.state("disconnected");
    })());
  }
  private state(state: McpInstanceSnapshot["state"], error?: unknown): void {
    if (this.closed && state !== "disconnected") return;
    this.snapshot.state = state;
    this.snapshot.observedAt = Date.now();
    if (error) this.snapshot.error = safeChannelError(error);
    else delete this.snapshot.error;
    this.options.changed(this);
  }
}
