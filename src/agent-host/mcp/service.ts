import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Tool, McpTimeoutError, McpConnectionClosedError } from "@earendil-works/pi-mcp";
import type {
  McpInstanceSnapshot,
  McpServerConfig,
  McpToolView,
  McpScope,
  McpTarget,
  McpPanelSnapshot,
  McpResourcePage,
} from "../../contract/mcp";
import { RpcError } from "../../contract/types";
import {
  McpConfigStore,
  mcpToolExposure,
  validateMcpConfig,
  assertMcpServerNames,
  projectConfig,
  restoreSecrets,
} from "./config-store";
import { isMcpManagedTool } from "../../shared/mcp-tool-policy";
import { mcpAuthenticationMode } from "../../shared/mcp-auth-mode";
import { isOrchestrationTool } from "../../shared/orchestration-tools";
import { McpOAuthStore } from "./oauth-store";
import { McpOAuthLoginManager, type McpLoginInput } from "./oauth-login";
import { mcpAuthConfiguration, mcpCredentialKey } from "./oauth-identity";
import { McpConnection, type McpConnectionOptions } from "./connection";
import { mcpModelContent } from "./model-content";
import { McpAuthorizationRequests } from "./authorization";

export interface McpSessionHooks {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  isEmpty(): boolean;
  isRunning(): boolean;
  isAllowed(name: string): boolean;
  setGrants?(names: string[]): void;
  declarations?(): string[] | undefined;
  orchestration?(): string[] | undefined;
  setDeclarations?(names: string[]): void;
}
interface Registration {
  connection: McpConnection;
  tool: Tool;
  name: string;
  exposure: McpToolView["exposure"];
  resource?: boolean;
}
interface SessionBinding {
  id: string;
  hooks: McpSessionHooks;
  connections: Map<string, McpConnection>;
  registrations: Map<string, Registration>;
  names: Map<string, string>;
  reconnect: Set<string>;
  temporary: Map<string, McpServerConfig>;
  generation: number;
  autoEnableCodemode: boolean;
  pending: boolean;
  queue: Promise<void>;
  closed: boolean;
  declarations?: Set<string>;
  grantRevision: number;
  error?: string;
}
interface McpExecutionDetails {
  mcp: { server: string; tool: string; generation: number; outcomeUnknown?: boolean };
}
export interface McpServiceOptions {
  changed(sessionId: string, instances: McpInstanceSnapshot[]): void;
  oauth: ConstructorParameters<typeof McpOAuthLoginManager>[1];
  connection?: Pick<McpConnectionOptions, "createTransport" | "fetch" | "runtime" | "providerToken">;
  settings?(sessionId: string): void;
}

export function mcpToolName(server: string, tool: string, taken: (name: string) => boolean): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (name.length <= 64 && !taken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

/** Sole owner of Desktop MCP clients; built-in SDK factories register the tools but do not own a second connection. */
export class McpService {
  readonly config: McpConfigStore;
  readonly credentials: McpOAuthStore;
  readonly login: McpOAuthLoginManager;
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly authorization = new McpAuthorizationRequests();
  private readonly inactive = new Map<string, McpPanelSnapshot["inactiveReason"]>();
  private readonly previews = new Set<McpConnection>();
  private readonly cleanups = new Set<() => Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly probes = new Map<string, { cancelled: boolean; connection?: McpConnection }>();
  constructor(
    private readonly options: McpServiceOptions,
    private readonly agentDir?: string,
  ) {
    this.config = new McpConfigStore(agentDir);
    this.credentials = new McpOAuthStore(agentDir);
    this.login = new McpOAuthLoginManager(this.credentials, {
      ...options.oauth,
      validate: async (input) => {
        await this.validateLogin(input);
        await options.oauth.validate?.(input);
      },
      updated: (snapshot) => {
        options.oauth.updated(snapshot);
        if (snapshot.state === "succeeded") {
          const identity = this.login.identity(snapshot.requestId);
          for (const binding of this.sessions.values())
            for (const connection of binding.connections.values())
              if (
                connection.config.url &&
                mcpAuthenticationMode(connection.config) === "oauth" &&
                mcpCredentialKey(connection.snapshot.name, connection.config.url) === identity &&
                connection.snapshot.state === "needs-auth"
              )
                void this.reconnect(binding.id, connection.snapshot.name).catch(() => undefined);
        }
      },
    });
    this.timer = setInterval(() => {
      for (const binding of this.sessions.values())
        if (!binding.closed && !binding.hooks.isRunning()) void this.reconcile(binding.id).catch(() => undefined);
    }, 2000);
    this.timer.unref();
  }
  private async validateLogin(input: McpLoginInput): Promise<void> {
    if (!input.target) return;
    const selected = await this.target(input.target);
    let config: McpServerConfig | undefined;
    if (selected.scope === "extension" && input.target.sessionId) {
      const binding = this.requireBinding(input.target.sessionId);
      const candidate =
        binding.temporary.get(input.name) ??
        binding.hooks.pi.getMcpServers().find((entry) => entry.name === input.name)?.config;
      if (candidate) {
        validateMcpConfig(input.name, candidate, "extension");
        config = candidate;
      }
    } else {
      const loaded = await this.config.effective(
        selected.cwd,
        Boolean(input.target.sessionId || input.target.scope === "project") && selected.trusted,
      );
      if (loaded.errors.length)
        throw new RpcError({ code: "CONFLICT", message: "Resolve MCP configuration errors before signing in" });
      const current = loaded.servers.find((entry) => entry.name === input.name);
      if (current?.scope === selected.scope && current.source === selected.source) config = current.config;
    }
    if (!config || config.enabled === false || mcpAuthConfiguration(config) !== mcpAuthConfiguration(input.config))
      throw new RpcError({ code: "CONFLICT", message: "MCP configuration changed; start sign-in again" });
  }
  async logout(name: string, url: string): Promise<void> {
    await this.login.cancelIdentity(name, url);
    await this.credentials.remove(name, url);
    const identity = mcpCredentialKey(name, url);
    await Promise.all(
      [...this.sessions.values()].flatMap((binding) =>
        [...binding.connections.values()]
          .filter(
            (connection) =>
              connection.config.url &&
              mcpAuthenticationMode(connection.config) === "oauth" &&
              mcpCredentialKey(connection.snapshot.name, connection.config.url) === identity,
          )
          .map((connection) => this.reconnect(binding.id, connection.snapshot.name)),
      ),
    );
  }
  async attach(hooks: McpSessionHooks): Promise<void> {
    const id = hooks.ctx.sessionManager.getSessionId();
    this.inactive.delete(id);
    if (this.sessions.has(id)) await this.detach(id);
    this.sessions.set(id, {
      id,
      hooks,
      connections: new Map(),
      registrations: new Map(),
      names: new Map(),
      reconnect: new Set(),
      temporary: new Map(),
      generation: 0,
      autoEnableCodemode: true,
      pending: false,
      queue: Promise.resolve(),
      closed: false,
      grantRevision: 0,
      declarations: hooks.declarations?.()
        ? new Set(hooks.declarations()!.filter((name) => !isOrchestrationTool(name)))
        : undefined,
    });
    await this.reconcile(id);
  }
  snapshot(sessionId: string): McpInstanceSnapshot[] {
    return [...(this.sessions.get(sessionId)?.connections.values() ?? [])].map((connection) => ({
      ...connection.snapshot,
    }));
  }
  panel(sessionId: string): McpPanelSnapshot {
    const binding = this.sessions.get(sessionId);
    return {
      instances: this.snapshot(sessionId),
      tools: binding ? this.tools(sessionId) : [],
      adapterActive: Boolean(binding),
      inactiveReason: binding ? undefined : this.inactive.get(sessionId),
      extensions: binding ? this.extensionEntries(sessionId) : [],
      projectTrusted: binding?.hooks.ctx.isProjectTrusted(),
      error: binding?.error,
      emptyTools: binding?.hooks.isEmpty(),
      declaredEntries: binding?.hooks.pi
        .getActiveTools()
        .filter((name) => isMcpManagedTool(name) && !name.startsWith("mcp__")),
      entryTools: binding?.hooks.pi
        .getAllTools()
        .filter((tool) => isMcpManagedTool(tool.name) && !tool.name.startsWith("mcp__") && tool.exposure !== "hidden")
        .map((tool) => tool.name),
    };
  }
  requestSettings(sessionId: string): void {
    this.options.settings?.(sessionId);
  }
  observeInactive(sessionId: string, reason: McpPanelSnapshot["inactiveReason"]): void {
    if (!this.sessions.has(sessionId)) this.inactive.set(sessionId, reason);
  }
  onShutdown(cleanup: () => Promise<void>): void {
    this.cleanups.add(cleanup);
  }
  declare(sessionId: string, names: string[]): McpPanelSnapshot {
    const binding = this.requireBinding(sessionId),
      known = new Set(
        binding.hooks.pi
          .getAllTools()
          .filter((tool) => tool.exposure !== "hidden")
          .map((tool) => tool.name),
      );
    if (
      binding.hooks.isEmpty() ||
      !Array.isArray(names) ||
      names.some((name) => !isMcpManagedTool(name) || !known.has(name))
    )
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid MCP tool declarations" });
    const entries = names.filter((name) => !name.startsWith("mcp__"));
    binding.hooks.setDeclarations?.(entries);
    binding.declarations = new Set(entries);
    binding.hooks.pi.setActiveTools([
      ...binding.hooks.pi.getActiveTools().filter((name) => !isMcpManagedTool(name) || name.startsWith("mcp__")),
      ...names,
    ]);
    this.publish(binding);
    return this.panel(sessionId);
  }
  extensionEntries(sessionId: string) {
    return [...this.requireBinding(sessionId).connections.values()]
      .filter((entry) => entry.snapshot.scope === "extension")
      .map((entry) => ({
        name: entry.snapshot.name,
        scope: "extension" as const,
        source: entry.snapshot.source,
        revision: entry.snapshot.revision,
        ...projectConfig(entry.config),
      }));
  }
  grant(sessionId: string, names: string[]): McpPanelSnapshot {
    const binding = this.requireBinding(sessionId),
      known = new Set(binding.hooks.pi.getAllTools().map((tool) => tool.name));
    if (binding.hooks.isEmpty())
      throw new RpcError({ code: "CONFLICT", message: "Enable a session tool preset before granting MCP tools" });
    if (
      !Array.isArray(names) ||
      names.length > 10000 ||
      names.some((name) => typeof name !== "string" || !isMcpManagedTool(name) || !known.has(name))
    )
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP grants must name registered MCP tools" });
    if (!binding.hooks.setGrants)
      throw new RpcError({ code: "UNSUPPORTED", message: "This session does not support MCP grants" });
    binding.hooks.setGrants([...new Set(names)]);
    binding.grantRevision++;
    this.activateCallers(binding);
    this.publish(binding);
    return this.panel(sessionId);
  }
  resetPermissionRequests(sessionId: string): void {
    this.authorization.reset(sessionId);
  }
  async requestAuthorization(
    sessionId: string,
    name: string,
    input: unknown,
    ctx: ExtensionContext,
    valid = () => true,
  ): Promise<boolean> {
    const binding = this.sessions.get(sessionId);
    if (!binding || binding.closed || binding.hooks.isEmpty() || !ctx.hasUI) return false;
    if (binding.hooks.isAllowed(name)) return true;
    const entry = binding.registrations.get(name);
    const server = input && typeof input === "object" ? (input as { server?: unknown }).server : undefined;
    const connections = entry
      ? [entry.connection]
      : [...binding.connections.values()].filter(
          (connection) =>
            connection.snapshot.state === "connected" &&
            (typeof server !== "string" || connection.snapshot.name === server),
        );
    if (!connections.length || connections.some((connection) => connection.snapshot.state !== "connected"))
      return false;
    const identities = connections.map(
      (connection) => `${connection.snapshot.name}:${connection.snapshot.generation}:${connection.snapshot.revision}`,
    );
    const grantRevision = binding.grantRevision;
    const requested = [...binding.registrations.values()].filter(
      (registration) => connections.includes(registration.connection) && registration.exposure !== "hidden",
    );
    const target = {
      servers: connections.map((connection) => connection.snapshot.name),
      tools: requested.map((registration) => registration.tool.name),
      identity: identities.join("\0"),
    };
    return this.authorization.request(sessionId, target, ctx, () => {
      if (
        !valid() ||
        binding.grantRevision !== grantRevision ||
        this.sessions.get(sessionId) !== binding ||
        binding.closed ||
        binding.hooks.isEmpty() ||
        connections.some(
          (connection, index) =>
            binding.connections.get(connection.snapshot.name) !== connection ||
            connection.snapshot.state !== "connected" ||
            `${connection.snapshot.name}:${connection.snapshot.generation}:${connection.snapshot.revision}` !==
              identities[index],
        )
      )
        return false;
      const retained = binding.hooks.pi
        .getAllTools()
        .filter((tool) => isMcpManagedTool(tool.name) && binding.hooks.isAllowed(tool.name))
        .map((tool) => tool.name);
      this.grant(sessionId, [
        ...new Set([
          ...retained,
          ...requested.map((registration) => registration.name),
          ...(this.panel(sessionId).entryTools ?? []),
        ]),
      ]);
      return true;
    });
  }
  async target(target: McpTarget): Promise<{
    config: McpServerConfig;
    cwd: string;
    trusted: boolean;
    source: string;
    scope: McpScope | "extension";
    revision: string;
    overrideSource?: string;
  }> {
    if (target.sessionId) {
      const binding = this.requireBinding(target.sessionId),
        connection = this.getConnection(target.sessionId, target.name);
      return {
        ...connection.snapshot,
        config: connection.config,
        trusted: binding.hooks.ctx.isProjectTrusted(),
      };
    }
    const cwd = target.cwd ?? homedir(),
      sessions = [...this.sessions.values()].filter((binding) => binding.hooks.ctx.cwd === cwd),
      trusted = sessions.length
        ? sessions.every((binding) => binding.hooks.ctx.isProjectTrusted())
        : SettingsManager.create(cwd, this.agentDir).isProjectTrusted();
    if (target.scope === "project" && !trusted)
      throw new RpcError({ code: "FORBIDDEN", message: "Project MCP configuration is not trusted" });
    const loaded = await this.config.effective(cwd, target.scope === "project" && trusted);
    const entry = loaded.servers.find((server) => server.name === target.name);
    if (!entry) throw new RpcError({ code: "NOT_FOUND", message: loaded.errors[0] ?? "MCP configuration not found" });
    return { ...entry, cwd, trusted };
  }
  async probe(target: McpTarget, requestId: string): Promise<McpPanelSnapshot> {
    if (this.probes.has(requestId)) throw new RpcError({ code: "CONFLICT", message: "MCP probe is already running" });
    const probe: { cancelled: boolean; connection?: McpConnection } = { cancelled: false };
    this.probes.set(requestId, probe);
    try {
      const entry = await this.target(target);
      if (probe.cancelled) throw new RpcError({ code: "CANCELLED", message: "MCP probe cancelled" });
      const connection = new McpConnection({
        ...this.options.connection,
        config: entry.config,
        credentials: this.credentials,
        trusted: entry.trusted,
        changed() {},
        snapshot: {
          name: target.name,
          sessionId: `probe-${requestId}`,
          cwd: entry.cwd,
          source: entry.source,
          scope: entry.scope,
          overrideSource: entry.overrideSource,
          revision: entry.revision,
          generation: 1,
          state: "not-started",
          observedAt: Date.now(),
          toolCount: 0,
        },
      });
      probe.connection = connection;
      await connection.start();
      if (probe.cancelled) throw new RpcError({ code: "CANCELLED", message: "MCP probe cancelled" });
      return {
        adapterActive: false,
        instances: [{ ...connection.snapshot }],
        tools: connection.tools.map((tool) => ({
          name: mcpToolName(target.name, tool.name, () => false),
          originalName: tool.name,
          server: target.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations ? { ...tool.annotations } : undefined,
          exposure: mcpToolExposure(entry.config, tool.name),
          active: false,
          callable: false,
          executionAllowed: false,
        })),
      };
    } finally {
      await probe.connection?.close();
      this.probes.delete(requestId);
    }
  }
  async cancelProbe(requestId: string): Promise<void> {
    const probe = this.probes.get(requestId);
    if (!probe) return;
    probe.cancelled = true;
    await probe.connection?.close();
  }
  async preview<T>(target: McpTarget, action: (connection: McpConnection) => Promise<T>): Promise<T> {
    if (target.sessionId) return action(this.getConnection(target.sessionId, target.name));
    const entry = await this.target(target),
      connection = new McpConnection({
        ...this.options.connection,
        config: entry.config,
        credentials: this.credentials,
        trusted: entry.trusted,
        changed() {},
        snapshot: {
          name: target.name,
          sessionId: "preview",
          cwd: entry.cwd,
          source: entry.source,
          scope: entry.scope,
          overrideSource: entry.overrideSource,
          revision: entry.revision,
          generation: 1,
          state: "not-started",
          observedAt: Date.now(),
          toolCount: 0,
        },
      });
    this.previews.add(connection);
    try {
      await connection.start();
      return await action(connection);
    } finally {
      await connection.close();
      this.previews.delete(connection);
    }
  }
  async resources(
    sessionId: string,
    name: string,
    cursor?: string,
    templateCursor?: string,
    signal?: AbortSignal,
  ): Promise<McpResourcePage> {
    const client = this.getConnection(sessionId, name).client;
    const [resources, templates] = await Promise.all([
      client.serverCapabilities?.resources
        ? client.listResourcesPage(cursor, { signal })
        : Promise.resolve({ resources: [] }),
      client.serverCapabilities?.resources
        ? client.listResourceTemplatesPage(templateCursor, { signal })
        : Promise.resolve({ resourceTemplates: [] }),
    ]);
    return {
      resources: resources.resources.filter(
        (item) => !item.uri.startsWith("ui://") && !item.mimeType?.includes("profile=mcp-app"),
      ),
      templates: templates.resourceTemplates.map((item) => ({ ...item, uri: item.uriTemplate })),
      nextCursor: "nextCursor" in resources ? resources.nextCursor : undefined,
      nextTemplateCursor: "nextCursor" in templates ? templates.nextCursor : undefined,
    };
  }
  async readResource(sessionId: string, name: string, uri: string, signal?: AbortSignal) {
    if (typeof uri !== "string" || uri.length > 8192 || uri.startsWith("ui://"))
      throw new RpcError({ code: "BAD_REQUEST", message: "Unsupported MCP resource URI" });
    const response = await this.getConnection(sessionId, name).client.readResource(uri, { signal });
    if (response.contents.some((item) => item.mimeType?.includes("profile=mcp-app")))
      throw new RpcError({ code: "UNSUPPORTED", message: "MCP Apps resources are not supported" });
    return response;
  }
  tools(sessionId: string): McpToolView[] {
    const binding = this.requireBinding(sessionId),
      active = new Set(binding.hooks.pi.getActiveTools());
    return [...binding.registrations.values()]
      .filter((entry) => entry.exposure !== "hidden")
      .map((entry) => ({
        name: entry.name,
        server: entry.connection.snapshot.name,
        originalName: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
        annotations: entry.tool.annotations ? { ...entry.tool.annotations } : undefined,
        exposure: entry.exposure,
        active: active.has(entry.name),
        callable: entry.connection.snapshot.state === "connected",
        executionAllowed: binding.hooks.isAllowed(entry.name),
      }));
  }
  getConnection(sessionId: string, name: string): McpConnection {
    const connection = this.requireBinding(sessionId).connections.get(name);
    if (!connection) throw new RpcError({ code: "NOT_FOUND", message: "MCP server is not present in this session" });
    return connection;
  }
  async changed(scope: McpScope, cwd?: string): Promise<void> {
    await this.login.cancelInvalid();
    await Promise.all(
      [...this.sessions.values()]
        .filter((binding) => scope === "global" || binding.hooks.ctx.cwd === cwd)
        .map((binding) => this.reconcile(binding.id)),
    );
  }
  reconcile(sessionId: string): Promise<void> {
    const binding = this.requireBinding(sessionId);
    const work = binding.queue.then(() => this.apply(binding));
    binding.queue = work.catch(() => undefined);
    return work;
  }
  async reconnect(sessionId: string, name: string): Promise<void> {
    const binding = this.requireBinding(sessionId),
      connection = this.getConnection(sessionId, name);
    if (binding.hooks.isRunning()) {
      binding.reconnect.add(name);
      binding.pending = true;
      connection.snapshot.pendingApply = true;
      this.publish(binding);
      return;
    }
    binding.connections.delete(name);
    this.withdraw(binding, connection);
    await connection.close();
    await this.reconcile(sessionId);
  }
  async updateExtension(
    sessionId: string,
    name: string,
    config: McpServerConfig,
    expectedRevision: string,
  ): Promise<void> {
    const binding = this.requireBinding(sessionId),
      connection = this.getConnection(sessionId, name);
    if (connection.snapshot.scope !== "extension")
      throw new RpcError({
        code: "BAD_REQUEST",
        message: "File-defined MCP configuration must be edited in its own scope",
      });
    const registered = binding.hooks.pi.getMcpServers().find((entry) => entry.name === name);
    const current = binding.temporary.get(name) ?? registered?.config;
    if (!current || createHash("sha256").update(JSON.stringify(current)).digest("hex") !== expectedRevision)
      throw new RpcError({ code: "CONFLICT", message: "MCP extension configuration changed; reload before saving" });
    validateMcpConfig(name, config);
    binding.temporary.set(name, restoreSecrets(config, connection.config));
    await this.login.cancelInvalid();
    await this.reconcile(sessionId);
  }
  async detach(sessionId: string): Promise<void> {
    this.authorization.cancel(sessionId);
    this.inactive.delete(sessionId);
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    binding.closed = true;
    this.sessions.delete(sessionId);
    await this.login.cancelSession(sessionId);
    await binding.queue;
    await Promise.allSettled([...binding.connections.values()].map((connection) => connection.close()));
  }
  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.login.shutdown();
    await Promise.allSettled([...this.previews].map((connection) => connection.close()));
    await Promise.all([...this.probes.keys()].map((id) => this.cancelProbe(id)));
    await Promise.all([...this.sessions.keys()].map((id) => this.detach(id)));
    this.inactive.clear();
    await Promise.all([...this.cleanups].map((cleanup) => cleanup()));
  }

  private async apply(binding: SessionBinding): Promise<void> {
    if (binding.closed) return;
    const loaded = await this.config.effective(binding.hooks.ctx.cwd, binding.hooks.ctx.isProjectTrusted());
    binding.error = loaded.errors.length ? loaded.errors.join("\n") : undefined;
    const desired = new Map(
      loaded.servers.map((entry) => [
        entry.name,
        entry as {
          name: string;
          config: McpServerConfig;
          scope: McpScope | "extension";
          source: string;
          revision: string;
          overrideSource?: string;
        },
      ]),
    );
    for (const registered of loaded.errors.length ? [] : binding.hooks.pi.getMcpServers()) {
      if (desired.has(registered.name)) continue;
      assertMcpServerNames([...desired.keys(), registered.name]);
      const config = binding.temporary.get(registered.name) ?? registered.config;
      validateMcpConfig(registered.name, config);
      desired.set(registered.name, {
        name: registered.name,
        config,
        scope: "extension",
        source: registered.extensionPath,
        revision: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      });
    }
    binding.autoEnableCodemode = loaded.autoEnableCodemode;
    for (const [name, connection] of binding.connections) {
      const next = desired.get(name),
        modified =
          binding.reconnect.has(name) ||
          !next ||
          next.scope !== connection.snapshot.scope ||
          next.source !== connection.snapshot.source ||
          next.overrideSource !== connection.snapshot.overrideSource ||
          JSON.stringify(next.config) !== JSON.stringify(connection.config);
      if (!modified) {
        connection.snapshot.revision = next!.revision;
        continue;
      }
      if (next?.config.enabled !== false && next && binding.hooks.isRunning()) {
        connection.snapshot.pendingApply = true;
        binding.pending = true;
        continue;
      }
      binding.connections.delete(name);
      binding.reconnect.delete(name);
      this.withdraw(binding, connection);
      await connection.close();
    }
    if (binding.closed) return;
    for (const [name, entry] of desired) {
      if (binding.connections.has(name)) continue;
      if (binding.hooks.isRunning() && entry.config.enabled !== false) {
        binding.pending = true;
        continue;
      }
      const connection = new McpConnection({
        ...this.options.connection,
        credentials: this.credentials,
        providerToken: (provider) => binding.hooks.ctx.modelRegistry.getApiKeyForProvider(provider),
        config: entry.config,
        trusted: binding.hooks.ctx.isProjectTrusted(),
        snapshot: {
          name,
          source: entry.source,
          scope: entry.scope,
          overrideSource: entry.overrideSource,
          revision: entry.revision,
          sessionId: binding.id,
          cwd: binding.hooks.ctx.cwd,
          generation: ++binding.generation,
          state: entry.config.enabled === false ? "disabled" : "not-started",
          observedAt: Date.now(),
          toolCount: 0,
        },
        changed: (current) => {
          if (binding.closed || binding.connections.get(name) !== current) return;
          if (current.snapshot.state === "connected") this.install(binding, current);
          else if (current.snapshot.state !== "connecting") this.withdraw(binding, current);
          this.publish(binding);
        },
      });
      binding.connections.set(name, connection);
      // A session starts independently of server network latency; tools appear only after actual initialization.
      void connection.start().catch(() => undefined);
    }
    if (!binding.hooks.isRunning()) {
      binding.pending = false;
      for (const connection of binding.connections.values()) delete connection.snapshot.pendingApply;
    }
    this.activateCallers(binding);
    this.publish(binding);
  }
  private install(binding: SessionBinding, connection: McpConnection): void {
    const originalNames = new Set(connection.tools.map((tool) => tool.name));
    for (const entry of [...binding.registrations.values()])
      if (entry.connection === connection && !entry.resource && !originalNames.has(entry.tool.name))
        this.hide(binding, entry.name);
    for (const tool of connection.tools) {
      const owner = `${connection.snapshot.name}\0${tool.name}`;
      const existing = [...binding.names.entries()].find(([, value]) => value === owner)?.[0];
      const name =
        existing ??
        mcpToolName(
          connection.snapshot.name,
          tool.name,
          (candidate) =>
            binding.names.has(candidate) || binding.hooks.pi.getAllTools().some((entry) => entry.name === candidate),
        );
      if (!existing && binding.names.size >= 10000)
        throw new Error("MCP catalog history exceeds the registry budget; reload this session");
      binding.names.set(name, owner);
      const exposure = mcpToolExposure(connection.config, tool.name),
        entry = { connection, tool, name, exposure };
      binding.registrations.set(name, entry);
      binding.hooks.pi.registerTool({
        name,
        label: `${connection.snapshot.name}: ${tool.name}`,
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        outputSchema: Type.Any(),
        exposure: exposure === "codemode-deferred" ? "deferred" : exposure,
        namespace: { name: `mcp__${connection.snapshot.name.replace(/[^A-Za-z0-9_-]/gu, "_")}` },
        annotations: tool.annotations,
        defaultActive: exposure === "direct" && !binding.hooks.isEmpty(),
        execute: async (_id, args: Record<string, unknown>, signal): Promise<AgentToolResult<McpExecutionDetails>> => {
          if (
            binding.closed ||
            binding.connections.get(connection.snapshot.name) !== connection ||
            connection.snapshot.state !== "connected" ||
            !binding.registrations.has(name)
          )
            throw new Error("MCP_CONNECTION_UNAVAILABLE: tool generation is no longer connected");
          try {
            const result = await connection.client.callTool(tool.name, args, { signal });
            return {
              content: mcpModelContent(result),
              structuredContent: JSON.parse(JSON.stringify(result)),
              details: {
                mcp: {
                  server: connection.snapshot.name,
                  tool: tool.name,
                  generation: connection.snapshot.generation,
                },
              },
              isError: result.isError,
            };
          } catch (error) {
            connection.authenticationRequired(error);
            const outcomeUnknown =
              error instanceof McpTimeoutError || error instanceof McpConnectionClosedError || signal?.aborted === true;
            return {
              content: [
                {
                  type: "text",
                  text: `${error instanceof Error ? error.message : "MCP call failed"}${outcomeUnknown ? " Outcome unknown; verify before repeating the operation." : ""}`,
                },
              ],
              details: {
                mcp: {
                  server: connection.snapshot.name,
                  tool: tool.name,
                  generation: connection.snapshot.generation,
                  outcomeUnknown,
                },
              },
              isError: true,
            };
          }
        },
      });
    }
    if (connection.client.serverCapabilities?.resources) this.installResource(binding, connection);
    this.activateCallers(binding);
  }
  private installResource(binding: SessionBinding, connection: McpConnection): void {
    const owner = `${connection.snapshot.name}\0__read_resource`,
      name =
        [...binding.names].find(([, value]) => value === owner)?.[0] ??
        mcpToolName(connection.snapshot.name, "read_resource", (candidate) => binding.names.has(candidate));
    binding.names.set(name, owner);
    const tool = {
      name: "__read_resource",
      description: "Read a server resource",
      inputSchema: { type: "object" as const, properties: { uri: { type: "string" } }, required: ["uri"] },
    };
    binding.registrations.set(name, { name, tool, connection, exposure: "deferred", resource: true });
    binding.hooks.pi.registerTool({
      name,
      label: `${connection.snapshot.name}: resource`,
      description: "Read one ordinary resource from this MCP server",
      exposure: "deferred",
      defaultActive: false,
      parameters: Type.Object({ uri: Type.String({ maxLength: 8192 }) }),
      execute: async (_id, params, signal) => {
        if (binding.connections.get(connection.snapshot.name) !== connection || binding.closed)
          throw new Error("MCP_CONNECTION_UNAVAILABLE");
        const response = await this.readResource(binding.id, connection.snapshot.name, params.uri, signal);
        return {
          content: mcpModelContent({
            content: response.contents.map((resource) => ({ type: "resource" as const, resource })),
          }),
          structuredContent: JSON.parse(JSON.stringify(response)),
          details: { mcp: { server: connection.snapshot.name, generation: connection.snapshot.generation } },
        };
      },
    });
  }
  private activateCallers(binding: SessionBinding): void {
    if (binding.hooks.isEmpty()) {
      binding.hooks.pi.setActiveTools([]);
      return;
    }
    const active = new Set(binding.hooks.pi.getActiveTools()),
      all = new Set(binding.hooks.pi.getAllTools().map((tool) => tool.name)),
      defaults = binding.hooks.pi.getSettings().defaultTools ?? [];
    if (binding.declarations) {
      for (const name of active) if (isMcpManagedTool(name) && !name.startsWith("mcp__")) active.delete(name);
      for (const name of binding.declarations) if (all.has(name)) active.add(name);
    }
    const orchestration = binding.hooks.orchestration?.();
    const exposures = [...binding.registrations.values()].map((entry) => entry.exposure);
    if (
      binding.autoEnableCodemode &&
      orchestration === undefined &&
      exposures.some((value) => value === "codemode" || value === "codemode-deferred") &&
      all.has("codemode") &&
      !defaults.includes("-codemode")
    )
      active.add("codemode");
    if (
      orchestration === undefined &&
      exposures.includes("deferred") &&
      all.has("tool_search") &&
      !defaults.includes("-tool_search")
    )
      active.add("tool_search");
    if (orchestration !== undefined) {
      for (const name of active) if (isOrchestrationTool(name)) active.delete(name);
      for (const name of orchestration) if (all.has(name)) active.add(name);
    }
    binding.hooks.pi.setActiveTools([...active]);
  }
  private hide(binding: SessionBinding, name: string): void {
    binding.registrations.delete(name);
    binding.hooks.pi.registerTool({
      name,
      label: name,
      description: "Disconnected MCP tool",
      exposure: "hidden",
      defaultActive: false,
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("MCP_CONNECTION_UNAVAILABLE");
      },
    });
  }
  private withdraw(binding: SessionBinding, connection: McpConnection): void {
    for (const entry of [...binding.registrations.values()])
      if (entry.connection === connection) this.hide(binding, entry.name);
  }
  private publish(binding: SessionBinding): void {
    this.options.changed(binding.id, this.snapshot(binding.id));
  }
  private requireBinding(sessionId: string): SessionBinding {
    const binding = this.sessions.get(sessionId);
    if (!binding)
      throw new RpcError({ code: "NOT_FOUND", message: "Desktop MCP adapter is not active in this session" });
    return binding;
  }
}
