import type { RpcServer } from "../../contract/rpc";
import semver from "semver";
import path from "node:path";
import {
  HERDR_AGENT_PROMPT_MAX_BYTES,
  isHerdrAgentAlias,
  HERDR_AGENT_WAIT_MAX_MS,
  HERDR_PANE_READ_MAX_BYTES,
  HERDR_PROTOCOL_VERSION,
  HERDR_SAFE_AGENT_KEYS,
  HERDR_SCHEMA_VERSION,
  HERDR_STARTABLE_AGENT_KINDS,
  isHerdrAgentKind,
  isHerdrStartableAgentKind,
  isHerdrSettings,
  type HerdrAgentKindDisplay,
  type HerdrAgentExplanation,
  type HerdrAgentCliDiagnostic,
  type HerdrAgentState,
  type HerdrDiagnostics,
  type HerdrFleetSnapshot,
  type HerdrPane,
  type HerdrPaneOutputWaitResult,
  type HerdrPaneProcessSummary,
  type HerdrRuntimeDescriptor,
  type HerdrRuntimeSnapshot,
  type HerdrSettings,
  type HerdrTab,
  type HerdrWorkspace,
} from "../../contract/herdr";
import { callMain } from "../parent-rpc";
import { herdrRuntimeController } from "./runtime-controller";
import { asHerdrError, HerdrBridgeError } from "./errors";
import {
  HERDR_V20_EVENT_SUBSCRIPTIONS,
  HERDR_V20_METHODS,
  isRecord,
  numberField,
  optionalStringField,
  stringField,
  type JsonRecord,
} from "./protocol-v20";
import { HerdrSocketClient } from "./socket-client";
import { HerdrTerminalRegistry } from "./terminal-session";

const EMPTY_FLEET: HerdrFleetSnapshot = {
  sourceGeneration: 0,
  revision: 0,
  receivedAt: 0,
  stale: true,
  workspaces: [],
  panes: [],
};
const MAX_WORKSPACES = 128;
const MAX_TABS = 512;
const MAX_PANES = 1_024;
const MAX_PROCESS_INFO_ENTRIES = 128;
const MAX_PUBLIC_PROCESS_ENTRIES = 32;

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !value.startsWith("-") &&
    !/[\0\r\n]/.test(value)
  );
}

function requireId(value: unknown, label: string): string {
  if (!isId(value)) throw new HerdrBridgeError("HERDR_INVALID_REQUEST", `${label} is invalid.`);
  return value;
}

function idField(value: JsonRecord, name: string): string {
  const id = stringField(value, name, 256);
  if (!isId(id)) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", `Herdr field ${name} is not a safe identifier.`);
  }
  return id;
}

function safeDiagnosticToken(value: unknown, max = 128): string | undefined {
  if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9_.:-]+$/.test(value)) return undefined;
  return value;
}

function safeProcessName(value: unknown, max = 128): string | undefined {
  if (typeof value !== "string" || !value || value.length > 512 || /[\0\r\n]/.test(value)) return undefined;
  const name = path.posix.basename(value.replace(/\\/g, "/")).slice(0, max);
  return name || undefined;
}

function isOptionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

export const __test = {
  mapFleet,
  agentKind,
  agentState,
  safeSessionDisplay,
  applyRuntimeDescriptor: (descriptor: HerdrRuntimeDescriptor) => herdrRuntimeController.apply(descriptor),
};

type HerdrSocketClientLike = Pick<HerdrSocketClient, "assertSafeEndpoint" | "request" | "subscribe">;

type HerdrBridgeOptions = {
  createClient?: (endpoint: string) => HerdrSocketClientLike;
  reconnectDelayMs?: (attempt: number) => number;
  assertAllowedPath?: (target: string) => Promise<void>;
};

function agentState(value: unknown): HerdrAgentState {
  return ["blocked", "working", "done", "idle", "unknown"].includes(String(value))
    ? (value as HerdrAgentState)
    : "unknown";
}

function agentKind(value: unknown): HerdrAgentKindDisplay {
  const normalized = String(value ?? "unknown")
    .toLowerCase()
    .replace(/^qwen(?:[-_ ]?code)?$/, "qwen")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
  return isHerdrAgentKind(normalized) ? normalized : `unknown:${normalized || "agent"}`;
}

function safeSessionDisplay(value: string, kind: "id" | "path"): string | undefined {
  if (!value) return undefined;
  if (kind === "path") {
    const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.at(-1)?.slice(0, 80);
  }
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function mapFleet(result: JsonRecord, previousRevision: number, sourceGeneration = 0): HerdrFleetSnapshot {
  if (result.type !== "session_snapshot" || !isRecord(result.snapshot)) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr snapshot response is invalid.");
  }
  const snapshot = result.snapshot;
  if (snapshot.protocol !== HERDR_PROTOCOL_VERSION) {
    throw new HerdrBridgeError(
      "HERDR_PROTOCOL_UNSUPPORTED",
      "The Herdr snapshot protocol is incompatible with this Pi Desktop release.",
    );
  }
  if (!Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.panes)) {
    throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr snapshot collections are invalid.");
  }
  if (
    snapshot.workspaces.length > MAX_WORKSPACES ||
    snapshot.tabs.length > MAX_TABS ||
    snapshot.panes.length > MAX_PANES
  ) {
    throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Herdr snapshot exceeded object limits.");
  }
  const wireAgents = Array.isArray(snapshot.agents) ? snapshot.agents.filter(isRecord) : [];
  const agentsByPane = new Map(wireAgents.map((item) => [String(item.pane_id ?? ""), item]));
  const panes: HerdrPane[] = snapshot.panes.filter(isRecord).map((wire) => {
    const id = idField(wire, "pane_id");
    const wireAgent = agentsByPane.get(id);
    const detected = wireAgent ?? wire;
    const detectedName =
      optionalStringField(detected, "agent", 128) ?? optionalStringField(detected, "display_agent", 128);
    let session: { kind: "id" | "path"; displayValue?: string } | undefined;
    if (wireAgent && isRecord(wireAgent.agent_session)) {
      const kind =
        wireAgent.agent_session.kind === "path" ? "path" : wireAgent.agent_session.kind === "id" ? "id" : null;
      const value = typeof wireAgent.agent_session.value === "string" ? wireAgent.agent_session.value : "";
      if (kind) session = { kind, displayValue: safeSessionDisplay(value, kind) };
    }
    return {
      id,
      terminalId: idField(wire, "terminal_id"),
      workspaceId: idField(wire, "workspace_id"),
      tabId: idField(wire, "tab_id"),
      title:
        optionalStringField(wire, "label", 256) ??
        optionalStringField(wire, "title", 256) ??
        optionalStringField(wire, "terminal_title_stripped", 256),
      cwd: optionalStringField(wire, "cwd"),
      foregroundCwd: optionalStringField(wire, "foreground_cwd"),
      focused: wire.focused === true,
      alive: true,
      revision: numberField(wire, "revision"),
      ...(detectedName
        ? {
            agent: {
              name: wireAgent ? optionalStringField(wireAgent, "name", 256) : undefined,
              kind: agentKind(detectedName),
              state: agentState(detected.agent_status),
              ...(session ? { session } : {}),
              launchPending: wireAgent?.launch_pending === true,
              interactiveReady: wireAgent?.interactive_ready === true,
              stateChangeSeq:
                wireAgent && Number.isSafeInteger(wireAgent.state_change_seq)
                  ? Number(wireAgent.state_change_seq)
                  : undefined,
            },
          }
        : {}),
    };
  });
  const paneIdsByTab = new Map<string, string[]>();
  for (const pane of panes) {
    const paneIds = paneIdsByTab.get(pane.tabId);
    if (paneIds) paneIds.push(pane.id);
    else paneIdsByTab.set(pane.tabId, [pane.id]);
  }
  const tabs = snapshot.tabs.filter(isRecord).map((wire) => {
    const id = idField(wire, "tab_id");
    return {
      id,
      workspaceId: idField(wire, "workspace_id"),
      name: optionalStringField(wire, "label", 256),
      focused: wire.focused === true,
      paneIds: paneIdsByTab.get(id) ?? [],
    };
  });
  const tabsByWorkspace = new Map<string, HerdrTab[]>();
  for (const tab of tabs) {
    const workspaceTabs = tabsByWorkspace.get(tab.workspaceId);
    if (workspaceTabs) workspaceTabs.push(tab);
    else tabsByWorkspace.set(tab.workspaceId, [tab]);
  }
  const workspaces = snapshot.workspaces.filter(isRecord).map((wire) => {
    const id = idField(wire, "workspace_id");
    const workspaceTabs = tabsByWorkspace.get(id) ?? [];
    const activeTab = workspaceTabs.find((tab) => tab.focused) ?? workspaceTabs[0];
    return {
      id,
      name: optionalStringField(wire, "label", 256),
      focused: wire.focused === true,
      rootPaneId: activeTab?.paneIds[0],
      tabs: workspaceTabs,
    };
  });
  return {
    sourceGeneration,
    revision: previousRevision + 1,
    receivedAt: Date.now(),
    stale: false,
    focusedWorkspaceId: typeof snapshot.focused_workspace_id === "string" ? snapshot.focused_workspace_id : undefined,
    focusedTabId: typeof snapshot.focused_tab_id === "string" ? snapshot.focused_tab_id : undefined,
    focusedPaneId: typeof snapshot.focused_pane_id === "string" ? snapshot.focused_pane_id : undefined,
    workspaces,
    panes,
  };
}

export class HerdrBridge {
  private descriptor = herdrRuntimeController.get();
  private runtimeRevision = 0;
  private runtime: HerdrRuntimeSnapshot = this.runtimeFromDescriptor(this.descriptor);
  private fleet: HerdrFleetSnapshot = structuredClone(EMPTY_FLEET);
  private client: HerdrSocketClientLike | null = null;
  private stopEvents: (() => void) | null = null;
  private stopRuntimeSubscription: () => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectPromise: Promise<HerdrRuntimeSnapshot> | null = null;
  private generation = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<HerdrFleetSnapshot> | null = null;
  private refreshPending = false;
  private snapshotInFlight = false;
  private eventsDirtyDuringSnapshot = false;
  private desiredConnection = false;
  private manuallyDisconnected = false;
  private manualConnectRequested = false;
  private terminalTeardownPromise: Promise<void> = Promise.resolve();
  private waits = new Map<string, AbortController>();
  private readonly runtimeListeners = new Set<(snapshot: HerdrRuntimeSnapshot) => void>();
  private readonly terminals: HerdrTerminalRegistry;

  constructor(
    private readonly server: RpcServer,
    private readonly options: HerdrBridgeOptions = {},
  ) {
    this.terminals = new HerdrTerminalRegistry(server);
    this.stopRuntimeSubscription = herdrRuntimeController.subscribe((descriptor) => this.applyDescriptor(descriptor));
  }

  getRuntime(): HerdrRuntimeSnapshot {
    return structuredClone(this.runtime);
  }

  getFleet(): HerdrFleetSnapshot {
    return structuredClone(this.fleet);
  }

  private agentCliDiagnostics(): HerdrAgentCliDiagnostic[] {
    const byKind = new Map((this.descriptor.agentClis ?? []).map((entry) => [entry.kind, entry]));
    return HERDR_STARTABLE_AGENT_KINDS.map((kind) => {
      const entry = byKind.get(kind);
      return entry
        ? structuredClone(entry)
        : { kind, available: false, status: "missing-locally", errorCode: "HERDR_AGENT_BINARY_MISSING" };
    });
  }

  async getDiagnostics(): Promise<HerdrDiagnostics> {
    const runtime = this.getRuntime();
    const fleet = this.getFleet();
    return {
      generatedAt: Date.now(),
      runtime: {
        status: runtime.status,
        mode: runtime.mode,
        source: runtime.binarySource,
        version: runtime.version,
        protocol: runtime.protocol,
        schemaVersion: runtime.schemaVersion,
        sessionName: runtime.sessionName,
      },
      fleet: {
        stale: fleet.stale,
        workspaces: fleet.workspaces.length,
        tabs: fleet.workspaces.reduce((total, workspace) => total + workspace.tabs.length, 0),
        panes: fleet.panes.length,
        agents: fleet.panes.filter((pane) => Boolean(pane.agent)).length,
      },
      terminal: this.terminals.diagnostics(),
      capabilities: runtime.capabilities,
      agentClis: this.agentCliDiagnostics(),
      ...(runtime.error ? { recentErrorCode: runtime.error.code } : {}),
    };
  }

  subscribeRuntime(listener: (snapshot: HerdrRuntimeSnapshot) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  async configure(settings: HerdrSettings): Promise<HerdrRuntimeSnapshot> {
    if (!isHerdrSettings(settings)) throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Herdr settings are invalid.");
    const descriptor = await callMain<HerdrRuntimeDescriptor>("herdr.configure", { settings });
    herdrRuntimeController.apply(descriptor);
    return this.getRuntime();
  }

  async probe(): Promise<HerdrRuntimeSnapshot> {
    const descriptor = await callMain<HerdrRuntimeDescriptor>("herdr.refreshRuntime", {});
    herdrRuntimeController.apply(descriptor);
    return this.getRuntime();
  }

  async connect(): Promise<HerdrRuntimeSnapshot> {
    this.desiredConnection = true;
    this.manuallyDisconnected = false;
    this.manualConnectRequested = true;
    return this.connectForDesiredState();
  }

  private async connectForDesiredState(): Promise<HerdrRuntimeSnapshot> {
    if (this.client && this.runtime.status === "ready") return this.getRuntime();
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectOnce();
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  private async connectOnce(): Promise<HerdrRuntimeSnapshot> {
    const generation = ++this.generation;
    this.clearReconnect();
    if (!this.descriptor.enabled) throw new HerdrBridgeError("HERDR_DISABLED", "Herdr integration is disabled.");
    if (this.descriptor.error) {
      this.setRuntime(this.runtimeFromDescriptor(this.descriptor));
      return this.getRuntime();
    }
    if (!this.descriptor.endpoint || !this.descriptor.executable) {
      throw new HerdrBridgeError("HERDR_BINARY_NOT_FOUND", "Herdr runtime is unavailable.");
    }
    await this.terminalTeardownPromise;
    if (generation !== this.generation) return this.getRuntime();
    this.setRuntime({ ...this.runtimeFromDescriptor(this.descriptor), status: "connecting" });
    const client =
      this.options.createClient?.(this.descriptor.endpoint) ?? new HerdrSocketClient(this.descriptor.endpoint);
    try {
      await client.assertSafeEndpoint();
      const pong = await client.request<JsonRecord>({ method: HERDR_V20_METHODS.ping, params: {} });
      if (pong.type !== "pong" || pong.protocol !== HERDR_PROTOCOL_VERSION) {
        throw new HerdrBridgeError(
          "HERDR_PROTOCOL_UNSUPPORTED",
          `The running Herdr Session does not speak protocol ${HERDR_PROTOCOL_VERSION}.`,
          false,
          true,
        );
      }
      if (
        typeof pong.version !== "string" ||
        !semver.valid(pong.version) ||
        !this.descriptor.version ||
        pong.version !== this.descriptor.version
      ) {
        throw new HerdrBridgeError(
          "HERDR_VERSION_UNSUPPORTED",
          "The running Herdr Session version does not match the probed executable.",
          false,
          true,
        );
      }
      if (this.descriptor.schemaVersion !== HERDR_SCHEMA_VERSION) {
        throw new HerdrBridgeError(
          "HERDR_SCHEMA_UNSUPPORTED",
          "The probed Herdr API schema is incompatible with Pi Desktop.",
          false,
          true,
        );
      }
      if (generation !== this.generation) return this.getRuntime();
      this.client = client;
      this.eventsDirtyDuringSnapshot = false;
      this.snapshotInFlight = true;
      let subscriptionError: HerdrBridgeError | undefined;
      try {
        const stopEvents = await this.subscribeEvents(client, generation);
        if (generation !== this.generation) {
          stopEvents();
          return this.getRuntime();
        }
        this.stopEvents = stopEvents;
      } catch (error) {
        subscriptionError = asHerdrError(error);
        this.stopEvents?.();
        this.stopEvents = null;
      }
      const result = await client.request<JsonRecord>({ method: HERDR_V20_METHODS.snapshot, params: {} });
      this.snapshotInFlight = false;
      if (generation !== this.generation) return this.getRuntime();
      this.fleet = mapFleet(result, this.fleet.revision, this.descriptor.hostGeneration ?? 0);
      this.server.emit("herdr.fleet", "*", this.getFleet());
      this.reconnectAttempt = 0;
      this.setRuntime({
        ...this.runtimeFromDescriptor(this.descriptor),
        version: pong.version,
        status: subscriptionError ? "degraded" : "ready",
        ...(subscriptionError ? { error: subscriptionError.toPublic() } : {}),
      });
      if (subscriptionError && this.shouldAutoReconnect()) this.scheduleReconnect();
      if (this.eventsDirtyDuringSnapshot) {
        this.eventsDirtyDuringSnapshot = false;
        this.scheduleSnapshotRefresh();
      }
      return this.getRuntime();
    } catch (error) {
      if (generation !== this.generation) return this.getRuntime();
      this.snapshotInFlight = false;
      this.eventsDirtyDuringSnapshot = false;
      this.stopEvents?.();
      this.stopEvents = null;
      if (this.client === client) this.client = null;
      const herdrError = asHerdrError(error);
      this.markFleetStale();
      const status = this.failureStatus(herdrError);
      this.setRuntime({
        ...this.runtimeFromDescriptor(this.descriptor),
        status,
        error: herdrError.toPublic(),
      });
      if (status === "reconnecting") this.scheduleReconnect();
      return this.getRuntime();
    }
  }

  disconnect(scheduleReconnect = false): Promise<void> {
    if (!scheduleReconnect) {
      this.desiredConnection = false;
      this.manuallyDisconnected = true;
      this.manualConnectRequested = false;
    }
    const teardown = this.teardownConnection();
    if (scheduleReconnect && this.shouldAutoReconnect()) {
      this.setRuntime({ ...this.runtimeFromDescriptor(this.descriptor), status: "reconnecting" });
      this.scheduleReconnect();
      return teardown;
    }
    this.setRuntime({
      ...this.runtimeFromDescriptor(this.descriptor),
      status: this.descriptor.enabled ? "unavailable" : "disabled",
    });
    return teardown;
  }

  private teardownConnection(): Promise<void> {
    this.generation += 1;
    this.connectPromise = null;
    this.clearReconnect();
    this.clearRefreshTimer();
    this.refreshPromise = null;
    this.refreshPending = false;
    this.snapshotInFlight = false;
    this.eventsDirtyDuringSnapshot = false;
    this.stopEvents?.();
    this.stopEvents = null;
    this.client = null;
    const closeTerminals = this.terminals.closeAll(true);
    this.terminalTeardownPromise = Promise.allSettled([this.terminalTeardownPromise, closeTerminals]).then(
      () => undefined,
    );
    for (const controller of this.waits.values()) controller.abort();
    this.waits.clear();
    this.markFleetStale();
    return this.terminalTeardownPromise;
  }

  async refreshSnapshot(): Promise<HerdrFleetSnapshot> {
    if (this.refreshPromise) {
      this.refreshPending = true;
      return this.refreshPromise;
    }
    const promise = this.refreshSnapshotOnce();
    this.refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
      if (this.refreshPending) {
        this.refreshPending = false;
        this.scheduleSnapshotRefresh();
      }
    }
  }

  private async refreshSnapshotOnce(): Promise<HerdrFleetSnapshot> {
    const client = this.requireReadable();
    const generation = this.generation;
    const result = await client.request<JsonRecord>({ method: HERDR_V20_METHODS.snapshot, params: {} });
    if (generation !== this.generation || client !== this.client) return this.getFleet();
    try {
      this.fleet = mapFleet(result, this.fleet.revision, this.descriptor.hostGeneration ?? 0);
    } catch (error) {
      const mapped = asHerdrError(error);
      if (mapped.code === "HERDR_PROTOCOL_LIMIT_EXCEEDED") this.handleConnectionLoss(mapped);
      throw mapped;
    }
    this.server.emit("herdr.fleet", "*", this.getFleet());
    return this.getFleet();
  }

  async createWorkspace(cwd: string, name?: string): Promise<{ workspaceId: string; rootPaneId: string }> {
    if (
      typeof cwd !== "string" ||
      !cwd ||
      cwd.length > 4_096 ||
      /[\0\r\n]/.test(cwd) ||
      (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 256 || /[\0\r\n]/.test(name)))
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace parameters are invalid.");
    }
    await this.assertCwdAllowed(cwd);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.workspaceCreate,
      params: { cwd, focus: true, ...(name ? { label: name } : {}), env: {} },
    });
    if (result.type !== "workspace_created" || !isRecord(result.workspace) || !isRecord(result.root_pane)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr workspace response is invalid.");
    }
    await this.refreshSnapshot();
    return {
      workspaceId: idField(result.workspace, "workspace_id"),
      rootPaneId: idField(result.root_pane, "pane_id"),
    };
  }

  async focusWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.workspaceFocus,
      params: { workspace_id: workspace.id },
    });
    if (
      result.type !== "workspace_info" ||
      !isRecord(result.workspace) ||
      idField(result.workspace, "workspace_id") !== workspace.id
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr workspace focus response is invalid.");
    }
    await this.refreshSnapshot();
    return { workspaceId: workspace.id };
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<{ workspaceId: string; name: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    if (typeof name !== "string" || !name.trim() || name.length > 256 || /[\0\r\n]/.test(name)) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace name is invalid.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.workspaceRename,
      params: { workspace_id: workspace.id, label: name },
    });
    if (
      result.type !== "workspace_info" ||
      !isRecord(result.workspace) ||
      idField(result.workspace, "workspace_id") !== workspace.id ||
      stringField(result.workspace, "label", 256) !== name
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr workspace rename response is invalid.");
    }
    await this.refreshSnapshot();
    return { workspaceId: workspace.id, name };
  }

  async closeWorkspace(workspaceId: string): Promise<{ workspaceId: string; closed: true }> {
    const workspace = this.requireWorkspace(workspaceId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.workspaceClose,
      params: { workspace_id: workspace.id },
    });
    if (result.type !== "ok") {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr workspace close response is invalid.");
    }
    await this.refreshSnapshot();
    return { workspaceId: workspace.id, closed: true };
  }

  async createTab(
    workspaceId: string,
    cwd: string,
    name?: string,
    focus = false,
  ): Promise<{ workspaceId: string; tabId: string; rootPaneId: string }> {
    const workspace = this.requireWorkspace(workspaceId);
    if (
      typeof cwd !== "string" ||
      !cwd ||
      cwd.length > 4_096 ||
      /[\0\r\n]/.test(cwd) ||
      (name !== undefined &&
        (typeof name !== "string" || !name.trim() || name.length > 256 || /[\0\r\n]/.test(name))) ||
      typeof focus !== "boolean"
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Tab creation parameters are invalid.");
    }
    await this.assertCwdAllowed(cwd);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.tabCreate,
      params: {
        workspace_id: workspace.id,
        cwd,
        focus,
        ...(name ? { label: name } : {}),
        env: {},
      },
    });
    if (result.type !== "tab_created" || !isRecord(result.tab) || !isRecord(result.root_pane)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr tab creation response is invalid.");
    }
    const responseWorkspaceId = idField(result.tab, "workspace_id");
    const tabId = idField(result.tab, "tab_id");
    const rootPaneId = idField(result.root_pane, "pane_id");
    if (
      responseWorkspaceId !== workspace.id ||
      idField(result.root_pane, "workspace_id") !== workspace.id ||
      idField(result.root_pane, "tab_id") !== tabId
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr tab creation response targets are invalid.");
    }
    await this.refreshSnapshot();
    return { workspaceId: responseWorkspaceId, tabId, rootPaneId };
  }

  async focusTab(tabId: string): Promise<{ workspaceId: string; tabId: string }> {
    const tab = this.requireTab(tabId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.tabFocus,
      params: { tab_id: tab.id },
    });
    if (
      result.type !== "tab_info" ||
      !isRecord(result.tab) ||
      idField(result.tab, "tab_id") !== tab.id ||
      idField(result.tab, "workspace_id") !== tab.workspaceId
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr tab focus response is invalid.");
    }
    await this.refreshSnapshot();
    return { workspaceId: tab.workspaceId, tabId: tab.id };
  }

  async renameTab(tabId: string, name: string): Promise<{ workspaceId: string; tabId: string; name: string }> {
    const tab = this.requireTab(tabId);
    if (typeof name !== "string" || !name.trim() || name.length > 256 || /[\0\r\n]/.test(name)) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Tab name is invalid.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.tabRename,
      params: { tab_id: tab.id, label: name },
    });
    if (
      result.type !== "tab_info" ||
      !isRecord(result.tab) ||
      idField(result.tab, "tab_id") !== tab.id ||
      idField(result.tab, "workspace_id") !== tab.workspaceId
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr tab rename response is invalid.");
    }
    const responseName = stringField(result.tab, "label", 256);
    await this.refreshSnapshot();
    return { workspaceId: tab.workspaceId, tabId: tab.id, name: responseName };
  }

  async splitPane(paneId: string, direction: "horizontal" | "vertical", cwd?: string): Promise<{ paneId: string }> {
    const target = this.requirePane(paneId);
    if (
      !(["horizontal", "vertical"] as const).includes(direction) ||
      (cwd !== undefined && (typeof cwd !== "string" || !cwd || cwd.length > 4_096 || /[\0\r\n]/.test(cwd)))
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane split parameters are invalid.");
    }
    if (cwd) await this.assertCwdAllowed(cwd);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneSplit,
      params: {
        target_pane_id: target.id,
        direction: direction === "horizontal" ? "right" : "down",
        focus: true,
        right_click: "herdr",
        env: {},
        ...(cwd ? { cwd } : {}),
      },
    });
    if (result.type !== "pane_info" || !isRecord(result.pane)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: idField(result.pane, "pane_id") };
  }

  async readPane(paneId: string, maxBytes = HERDR_PANE_READ_MAX_BYTES): Promise<{ text: string; truncated: boolean }> {
    this.requirePane(paneId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HERDR_PANE_READ_MAX_BYTES) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane read limit is invalid.");
    }
    const lines = Math.max(1, Math.min(10_000, Math.ceil(maxBytes / 80)));
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneRead,
      params: { pane_id: paneId, source: "recent_unwrapped", lines, format: "text", strip_ansi: true },
    });
    if (result.type !== "pane_read" || !isRecord(result.read) || typeof result.read.text !== "string") {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane read response is invalid.");
    }
    const bytes = Buffer.from(result.read.text, "utf8");
    return {
      text: bytes.length > maxBytes ? bytes.subarray(bytes.length - maxBytes).toString("utf8") : result.read.text,
      truncated: result.read.truncated === true || bytes.length > maxBytes,
    };
  }

  async getPaneProcessInfo(paneId: string): Promise<HerdrPaneProcessSummary> {
    const pane = this.requirePane(paneId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneProcessInfo,
      params: { pane_id: pane.id },
    });
    if (
      result.type !== "pane_process_info" ||
      !isRecord(result.process_info) ||
      idField(result.process_info, "pane_id") !== pane.id ||
      !isOptionalNonnegativeInteger(result.process_info.shell_pid) ||
      !isOptionalNonnegativeInteger(result.process_info.foreground_process_group_id)
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane process response is invalid.");
    }
    const foreground = result.process_info.foreground_processes;
    if (foreground !== undefined && !Array.isArray(foreground)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane process list is invalid.");
    }
    const processes = (foreground ?? []).filter(isRecord);
    if (processes.length !== (foreground ?? []).length) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane process entry is invalid.");
    }
    if (processes.length > MAX_PROCESS_INFO_ENTRIES) {
      throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Herdr pane process list exceeded object limits.");
    }
    const visibleProcesses = processes.slice(0, MAX_PUBLIC_PROCESS_ENTRIES).map((processInfo) => {
      const name = safeProcessName(processInfo.name);
      if (!name || !isOptionalNonnegativeInteger(processInfo.pid)) {
        throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane process entry is invalid.");
      }
      const processCwd = optionalStringField(processInfo, "cwd");
      return {
        name,
        cwdMatchesPane: Boolean(processCwd && (processCwd === pane.foregroundCwd || processCwd === pane.cwd)),
      };
    });
    return {
      paneId: pane.id,
      shellDetected: result.process_info.shell_pid !== undefined && result.process_info.shell_pid !== null,
      foregroundProcessGroupDetected:
        result.process_info.foreground_process_group_id !== undefined &&
        result.process_info.foreground_process_group_id !== null,
      processCount: processes.length,
      truncated: processes.length > visibleProcesses.length,
      foregroundProcesses: visibleProcesses,
      ...(pane.agent
        ? {
            agent: {
              kind: pane.agent.kind,
              state: pane.agent.state,
              interactiveReady: pane.agent.interactiveReady === true,
              launchPending: pane.agent.launchPending === true,
            },
          }
        : {}),
    };
  }

  async waitForPaneOutput(
    paneId: string,
    match: unknown,
    timeoutMs: unknown,
    requestId: unknown,
  ): Promise<HerdrPaneOutputWaitResult> {
    const pane = this.requirePane(paneId);
    if (
      typeof match !== "string" ||
      !match ||
      Buffer.byteLength(match, "utf8") > 4_096 ||
      /\0/.test(match) ||
      !Number.isSafeInteger(timeoutMs) ||
      Number(timeoutMs) < 100 ||
      Number(timeoutMs) > HERDR_AGENT_WAIT_MAX_MS ||
      !isId(requestId) ||
      this.waits.has(requestId)
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane output wait parameters are invalid.");
    }
    const controller = new AbortController();
    this.waits.set(requestId, controller);
    try {
      const result = await this.requireReady().request<JsonRecord>({
        method: HERDR_V20_METHODS.paneWaitForOutput,
        params: {
          pane_id: pane.id,
          source: "recent_unwrapped",
          match: { type: "substring", value: match },
          lines: 1_000,
          strip_ansi: true,
          timeout_ms: timeoutMs,
        },
        timeoutMs: Number(timeoutMs) + 2_000,
        signal: controller.signal,
      });
      if (
        result.type !== "output_matched" ||
        idField(result, "pane_id") !== pane.id ||
        !isRecord(result.read) ||
        idField(result.read, "pane_id") !== pane.id
      ) {
        throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane output wait response is invalid.");
      }
      const matchedLine = optionalStringField(result, "matched_line", 4_096);
      return {
        paneId: pane.id,
        matched: true,
        timedOut: false,
        revision: numberField(result, "revision"),
        ...(matchedLine ? { matchedLine } : {}),
      };
    } catch (error) {
      const mapped = asHerdrError(error);
      if (mapped.code === "HERDR_REQUEST_TIMEOUT") {
        return { paneId: pane.id, matched: false, timedOut: true };
      }
      throw mapped;
    } finally {
      this.waits.delete(requestId);
    }
  }

  async focusPane(paneId: string): Promise<{ paneId: string; workspaceId: string; tabId: string }> {
    const pane = this.requirePane(paneId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneFocus,
      params: { pane_id: pane.id },
    });
    if (
      result.type !== "pane_info" ||
      !isRecord(result.pane) ||
      idField(result.pane, "pane_id") !== pane.id ||
      idField(result.pane, "workspace_id") !== pane.workspaceId ||
      idField(result.pane, "tab_id") !== pane.tabId
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane focus response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: pane.id, workspaceId: pane.workspaceId, tabId: pane.tabId };
  }

  async renamePane(paneId: string, name: string): Promise<{ paneId: string; name: string }> {
    const pane = this.requirePane(paneId);
    if (typeof name !== "string" || !name.trim() || name.length > 256 || /[\0\r\n]/.test(name)) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane name is invalid.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneRename,
      params: { pane_id: pane.id, label: name },
    });
    if (
      result.type !== "pane_info" ||
      !isRecord(result.pane) ||
      idField(result.pane, "pane_id") !== pane.id ||
      optionalStringField(result.pane, "label", 256) !== name
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane rename response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: pane.id, name };
  }

  async closePane(paneId: string): Promise<{ paneId: string; workspaceId: string; tabId: string; closed: true }> {
    const pane = this.requirePane(paneId);
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneClose,
      params: { pane_id: pane.id },
    });
    if (result.type !== "ok") {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr pane close response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: pane.id, workspaceId: pane.workspaceId, tabId: pane.tabId, closed: true };
  }

  async startAgent(paneId: string, kind: unknown): Promise<{ paneId: string; state: HerdrAgentState }> {
    const pane = this.requirePane(paneId);
    if (!isHerdrAgentKind(kind) || !isHerdrStartableAgentKind(kind))
      throw new HerdrBridgeError("HERDR_AGENT_KIND_UNSUPPORTED", "Agent kind is unsupported.");
    const cwd = pane.foregroundCwd ?? pane.cwd;
    if (!cwd) throw new HerdrBridgeError("HERDR_CWD_FORBIDDEN", "The Herdr pane has no approved working directory.");
    await this.assertCwdAllowed(cwd);
    if (pane.agent) {
      throw new HerdrBridgeError("HERDR_AGENT_NOT_READY", "The Herdr pane already has a managed Agent.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.agentStart,
      params: { name: kind, kind, pane_id: paneId, args: [], timeout_ms: 60_000 },
      timeoutMs: 65_000,
    });
    if (result.type !== "agent_started" || !isRecord(result.agent)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent start response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId, state: agentState(result.agent.agent_status) };
  }

  async explainAgent(paneId: string): Promise<HerdrAgentExplanation> {
    const pane = this.requirePane(paneId);
    if (!pane.agent) {
      return {
        paneId: pane.id,
        detected: false,
        cli: { startSupported: false, candidates: this.agentCliDiagnostics() },
        detection: { available: false },
      };
    }
    const startableKind = isHerdrStartableAgentKind(pane.agent.kind) ? pane.agent.kind : undefined;
    const startSupported = startableKind !== undefined;
    const cliAvailable = startableKind
      ? this.agentCliDiagnostics().find((candidate) => candidate.kind === startableKind)?.available
      : undefined;
    let result: JsonRecord;
    try {
      result = await this.requireReady().request<JsonRecord>({
        method: HERDR_V20_METHODS.agentExplain,
        params: { target: pane.id },
      });
    } catch (error) {
      const mapped = asHerdrError(error);
      if (mapped.code !== "HERDR_AGENT_NOT_READY") throw mapped;
      return {
        paneId: pane.id,
        detected: true,
        agent: {
          name: pane.agent.name,
          kind: pane.agent.kind,
          state: pane.agent.state,
          interactiveReady: pane.agent.interactiveReady === true,
          launchPending: pane.agent.launchPending === true,
        },
        cli: { startSupported, ...(cliAvailable !== undefined ? { available: cliAvailable } : {}) },
        detection: { available: false },
      };
    }
    if (result.type !== "agent_explain" || !isRecord(result.explain)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent explanation response is invalid.");
    }
    const explain = result.explain;
    const evaluatedRules = explain.evaluated_rules;
    if (evaluatedRules !== undefined && !Array.isArray(evaluatedRules)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent explanation rules are invalid.");
    }
    if ((evaluatedRules?.length ?? 0) > 128) {
      throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Herdr agent explanation exceeded object limits.");
    }
    const matchedRule = explain.matched_rule;
    if (matchedRule !== undefined && matchedRule !== null && !isRecord(matchedRule)) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr matched Agent rule is invalid.");
    }
    const matchedRuleId = isRecord(matchedRule) ? safeDiagnosticToken(matchedRule.id) : undefined;
    const matchedRuleState = isRecord(matchedRule) ? agentState(matchedRule.state) : undefined;
    const matchedRuleRegion = isRecord(matchedRule) ? safeDiagnosticToken(matchedRule.region) : undefined;
    return {
      paneId: pane.id,
      detected: true,
      agent: {
        name: pane.agent.name,
        kind: pane.agent.kind,
        state: pane.agent.state,
        interactiveReady: pane.agent.interactiveReady === true,
        launchPending: pane.agent.launchPending === true,
      },
      cli: { startSupported, ...(cliAvailable !== undefined ? { available: cliAvailable } : {}) },
      detection: {
        available: true,
        ...(evaluatedRules ? { evaluatedRuleCount: evaluatedRules.length } : {}),
        ...(matchedRuleId
          ? {
              matchedRule: {
                id: matchedRuleId,
                ...(matchedRuleState ? { state: matchedRuleState } : {}),
                ...(matchedRuleRegion ? { region: matchedRuleRegion } : {}),
              },
            }
          : {}),
        ...(safeDiagnosticToken(explain.fallback_reason)
          ? { fallbackReason: safeDiagnosticToken(explain.fallback_reason) }
          : {}),
        ...(safeDiagnosticToken(explain.manifest_source)
          ? { manifestSource: safeDiagnosticToken(explain.manifest_source) }
          : {}),
        ...(safeDiagnosticToken(explain.manifest_version)
          ? { manifestVersion: safeDiagnosticToken(explain.manifest_version) }
          : {}),
        ...(typeof explain.screen_detection_skipped === "boolean"
          ? { screenDetectionSkipped: explain.screen_detection_skipped }
          : {}),
        ...(typeof explain.skip_state_update === "boolean" ? { skipStateUpdate: explain.skip_state_update } : {}),
        ...(safeDiagnosticToken(explain.skipped_update_reason)
          ? { skippedUpdateReason: safeDiagnosticToken(explain.skipped_update_reason) }
          : {}),
        ...(typeof explain.visible_blocker === "boolean" ? { visibleBlocker: explain.visible_blocker } : {}),
        ...(typeof explain.visible_idle === "boolean" ? { visibleIdle: explain.visible_idle } : {}),
        ...(typeof explain.visible_working === "boolean" ? { visibleWorking: explain.visible_working } : {}),
      },
    };
  }

  async focusAgent(paneId: string): Promise<{ paneId: string; agentKind: HerdrAgentKindDisplay }> {
    const pane = this.requirePane(paneId);
    if (!pane.agent) throw new HerdrBridgeError("HERDR_AGENT_NOT_READY", "No Agent is detected in this pane.");
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.agentFocus,
      params: { target: pane.id },
    });
    if (result.type !== "agent_info" || !isRecord(result.agent) || idField(result.agent, "pane_id") !== pane.id) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent focus response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: pane.id, agentKind: pane.agent.kind };
  }

  async renameAgent(
    paneId: string,
    name: string,
  ): Promise<{ paneId: string; agentKind: HerdrAgentKindDisplay; name: string }> {
    const pane = this.requirePane(paneId);
    if (!pane.agent) throw new HerdrBridgeError("HERDR_AGENT_NOT_READY", "No Agent is detected in this pane.");
    if (!isHerdrAgentAlias(name)) {
      throw new HerdrBridgeError(
        "HERDR_INVALID_REQUEST",
        "Agent name must be a lowercase slug of 1 to 64 letters, digits, underscores, or hyphens.",
      );
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.agentRename,
      params: { target: pane.id, name },
    });
    if (
      result.type !== "agent_info" ||
      !isRecord(result.agent) ||
      idField(result.agent, "pane_id") !== pane.id ||
      optionalStringField(result.agent, "name", 256) !== name
    ) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent rename response is invalid.");
    }
    await this.refreshSnapshot();
    return { paneId: pane.id, agentKind: pane.agent.kind, name };
  }

  async closeAgent(paneId: string): Promise<{
    paneId: string;
    workspaceId: string;
    tabId: string;
    agentKind: HerdrAgentKindDisplay;
    paneClosed: true;
  }> {
    const pane = this.requirePane(paneId);
    if (!pane.agent) throw new HerdrBridgeError("HERDR_AGENT_NOT_READY", "No Agent is detected in this pane.");
    const agentKind = pane.agent.kind;
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.paneClose,
      params: { pane_id: pane.id },
    });
    if (result.type !== "ok") {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr Agent pane close response is invalid.");
    }
    await this.refreshSnapshot();
    return {
      paneId: pane.id,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      agentKind,
      paneClosed: true,
    };
  }

  async promptAgent(paneId: string, prompt: unknown): Promise<{ accepted: true }> {
    this.requirePane(paneId);
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      Buffer.byteLength(prompt, "utf8") > HERDR_AGENT_PROMPT_MAX_BYTES ||
      /\0/.test(prompt)
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Agent prompt is invalid.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.agentPrompt,
      params: { target: paneId, text: prompt },
      timeoutMs: 30_000,
    });
    if (result.type !== "agent_prompted" || !isRecord(result.agent) || idField(result.agent, "pane_id") !== paneId) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent prompt response is invalid.");
    }
    this.scheduleSnapshotRefresh();
    return { accepted: true };
  }

  async sendAgentKeys(paneId: string, keys: unknown): Promise<{ accepted: true }> {
    this.requirePane(paneId);
    if (
      !Array.isArray(keys) ||
      keys.length < 1 ||
      keys.length > 8 ||
      keys.some((key) => !(HERDR_SAFE_AGENT_KEYS as readonly unknown[]).includes(key))
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Agent keys are invalid.");
    }
    const result = await this.requireReady().request<JsonRecord>({
      method: HERDR_V20_METHODS.agentSendKeys,
      params: { target: paneId, keys },
    });
    if (result.type !== "agent_info" || !isRecord(result.agent) || idField(result.agent, "pane_id") !== paneId) {
      throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent key response is invalid.");
    }
    return { accepted: true };
  }

  async waitAgent(
    paneId: string,
    states: unknown,
    timeoutMs: unknown,
    requestId: unknown,
  ): Promise<{ state: HerdrAgentState; timedOut: boolean }> {
    this.requirePane(paneId);
    if (
      !Array.isArray(states) ||
      states.length < 1 ||
      states.length > 5 ||
      states.some((state) => !["blocked", "working", "done", "idle", "unknown"].includes(String(state))) ||
      !Number.isSafeInteger(timeoutMs) ||
      Number(timeoutMs) < 100 ||
      Number(timeoutMs) > HERDR_AGENT_WAIT_MAX_MS ||
      !isId(requestId) ||
      this.waits.has(requestId)
    ) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Agent wait parameters are invalid.");
    }
    const controller = new AbortController();
    this.waits.set(requestId, controller);
    try {
      const result = await this.requireReady().request<JsonRecord>({
        method: HERDR_V20_METHODS.agentWait,
        params: { target: paneId, until: states, timeout_ms: timeoutMs },
        timeoutMs: Number(timeoutMs) + 2_000,
        signal: controller.signal,
      });
      if (result.type !== "agent_info" || !isRecord(result.agent)) {
        throw new HerdrBridgeError("HERDR_SCHEMA_INVALID", "Herdr agent wait response is invalid.");
      }
      return { state: agentState(result.agent.agent_status), timedOut: false };
    } catch (error) {
      const mapped = asHerdrError(error);
      if (mapped.code === "HERDR_REQUEST_TIMEOUT") {
        const pane = this.fleet.panes.find((candidate) => candidate.id === paneId && candidate.alive);
        return { state: pane?.agent?.state ?? "unknown", timedOut: true };
      }
      throw mapped;
    } finally {
      this.waits.delete(requestId);
    }
  }

  cancelWait(requestId: unknown): void {
    if (!isId(requestId)) throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Wait request id is invalid.");
    this.waits.get(requestId)?.abort();
    this.waits.delete(requestId);
  }

  async openTerminal(paneId: string, mode: "observe" | "control", cols: number, rows: number, takeover = false) {
    this.requireReady();
    const generation = this.generation;
    if (
      !this.runtime.capabilities.terminalObserve ||
      (mode === "control" && !this.runtime.capabilities.terminalControl)
    ) {
      throw new HerdrBridgeError("HERDR_TERMINAL_PROTOCOL", "Herdr terminal containment is unavailable.");
    }
    this.requirePane(paneId);
    if (mode !== "observe" && mode !== "control") {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal mode is invalid.");
    }
    const terminal = await this.terminals.open(this.descriptor, paneId, mode, cols, rows, takeover);
    if (generation !== this.generation || !this.client || this.runtime.status !== "ready") {
      await terminal.close(mode === "control");
      throw new HerdrBridgeError(
        "HERDR_ENDPOINT_UNAVAILABLE",
        "The Herdr connection changed while the terminal was opening.",
        true,
      );
    }
    return { terminalId: terminal.terminalId, mode, controller: mode === "control" };
  }

  getTerminals(): HerdrTerminalRegistry {
    return this.terminals;
  }

  async shutdown(): Promise<void> {
    this.stopRuntimeSubscription();
    this.manuallyDisconnected = true;
    this.desiredConnection = false;
    this.manualConnectRequested = false;
    await this.disconnect(false);
  }

  private applyDescriptor(descriptor: HerdrRuntimeDescriptor): void {
    const previous = this.descriptor;
    const changedEndpoint = descriptor.endpoint !== previous.endpoint || descriptor.executable !== previous.executable;
    const wasReady = Boolean(this.client && this.runtime.status === "ready");
    this.descriptor = descriptor;

    if (!descriptor.enabled) {
      this.desiredConnection = false;
      this.manuallyDisconnected = false;
      this.manualConnectRequested = false;
      void this.teardownConnection();
      this.setRuntime(this.runtimeFromDescriptor(descriptor));
      return;
    }

    const autoConnectionEnabled = (!previous.enabled || !previous.autoConnect) && descriptor.autoConnect;
    if (autoConnectionEnabled) {
      this.desiredConnection = true;
      this.manuallyDisconnected = false;
      this.manualConnectRequested = false;
    } else if (previous.autoConnect && !descriptor.autoConnect && !this.manualConnectRequested) {
      this.desiredConnection = false;
    }

    if (descriptor.error) {
      void this.teardownConnection();
      this.setRuntime(this.runtimeFromDescriptor(descriptor));
      return;
    }

    if (!descriptor.endpoint || !descriptor.executable) {
      void this.teardownConnection();
      this.setRuntime(this.runtimeFromDescriptor(descriptor));
      return;
    }

    if (changedEndpoint || (!descriptor.autoConnect && !wasReady && !this.desiredConnection)) {
      void this.teardownConnection();
    }

    if (wasReady && !changedEndpoint) {
      this.setRuntime({ ...this.runtimeFromDescriptor(descriptor), status: "ready" });
      return;
    }

    if (this.desiredConnection && !this.manuallyDisconnected) {
      void this.connectForDesiredState();
      return;
    }

    this.setRuntime({ ...this.runtimeFromDescriptor(descriptor), status: "unavailable" });
  }

  private runtimeFromDescriptor(descriptor: HerdrRuntimeDescriptor): HerdrRuntimeSnapshot {
    const status: HerdrRuntimeSnapshot["status"] = !descriptor.enabled
      ? "disabled"
      : descriptor.error?.code === "HERDR_VERSION_TOO_OLD" ||
          descriptor.error?.code === "HERDR_VERSION_UNSUPPORTED" ||
          descriptor.error?.code === "HERDR_PROTOCOL_UNSUPPORTED" ||
          descriptor.error?.code === "HERDR_SCHEMA_UNSUPPORTED"
        ? "incompatible"
        : descriptor.error
          ? "unavailable"
          : "probing";
    return {
      status,
      mode: descriptor.enabled ? descriptor.mode : "disabled",
      version: descriptor.version,
      protocol: descriptor.protocol,
      schemaVersion: descriptor.schemaVersion,
      sessionName: descriptor.sessionName,
      binarySource: descriptor.binarySource,
      releaseControlOnViewClose: descriptor.releaseControlOnViewClose,
      capabilities: {
        readOnly: false,
        agentControl: false,
        terminalObserve: false,
        terminalControl: false,
        ansiOnly: true,
        graphics: false,
      },
      error: descriptor.error,
      sourceGeneration: descriptor.hostGeneration ?? 0,
      descriptorRevision: descriptor.revision,
      revision: this.runtimeRevision,
      receivedAt: 0,
    };
  }

  private setRuntime(snapshot: HerdrRuntimeSnapshot): void {
    const ready = snapshot.status === "ready";
    const readable = ready || snapshot.status === "degraded";
    const terminalReady = ready && process.platform !== "win32";
    this.runtime = {
      ...snapshot,
      revision: ++this.runtimeRevision,
      receivedAt: Math.max(Date.now(), this.runtime.receivedAt + 1),
      capabilities: {
        readOnly: readable,
        agentControl: ready,
        terminalObserve: terminalReady,
        terminalControl: terminalReady,
        ansiOnly: true,
        graphics: false,
      },
    };
    this.server.emit("herdr.runtime", "*", this.getRuntime());
    const current = this.getRuntime();
    for (const listener of this.runtimeListeners) {
      try {
        listener(current);
      } catch {
        // Runtime state must not be rolled back because an optional consumer failed to refresh.
      }
    }
  }

  private requireReady(): HerdrSocketClientLike {
    if (!this.client || this.runtime.status !== "ready") {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr is not connected.", true);
    }
    return this.client;
  }

  private async assertCwdAllowed(cwd: string): Promise<void> {
    if (!this.options.assertAllowedPath) return;
    try {
      await this.options.assertAllowedPath(cwd);
    } catch {
      throw new HerdrBridgeError("HERDR_CWD_FORBIDDEN", "The Herdr working directory is outside allowed roots.");
    }
  }

  private requireReadable(): HerdrSocketClientLike {
    if (!this.client || (this.runtime.status !== "ready" && this.runtime.status !== "degraded")) {
      throw new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr is not connected.", true);
    }
    return this.client;
  }

  private requireWorkspace(workspaceId: unknown): HerdrWorkspace {
    const id = requireId(workspaceId, "Workspace id");
    const workspace = this.fleet.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace is not present in the current snapshot.");
    }
    return workspace;
  }

  private requireTab(tabId: unknown): HerdrTab {
    const id = requireId(tabId, "Tab id");
    const tab = this.fleet.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === id);
    if (!tab) throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Tab is not present in the current snapshot.");
    return tab;
  }

  private requirePane(paneId: unknown): HerdrPane {
    const id = requireId(paneId, "Pane id");
    const pane = this.fleet.panes.find((candidate) => candidate.id === id && candidate.alive);
    if (!pane) throw new HerdrBridgeError("HERDR_PANE_NOT_FOUND", "Pane is not present in the current snapshot.");
    return pane;
  }

  private subscribeEvents(client: HerdrSocketClientLike, generation: number): Promise<() => void> {
    this.stopEvents?.();
    this.stopEvents = null;
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      let stopUnderlying: () => void = () => undefined;
      const stop = () => {
        stopUnderlying();
        if (!settled) {
          settled = true;
          reject(new HerdrBridgeError("HERDR_REQUEST_TIMEOUT", "Herdr event subscription was cancelled.", true));
        }
      };
      stopUnderlying = client.subscribe(
        HERDR_V20_EVENT_SUBSCRIPTIONS,
        () => {
          if (generation !== this.generation || client !== this.client) return;
          if (this.snapshotInFlight) this.eventsDirtyDuringSnapshot = true;
          else this.scheduleSnapshotRefresh();
        },
        (error) => {
          if (generation !== this.generation || client !== this.client) return;
          if (!ready) {
            if (settled) return;
            settled = true;
            reject(error ?? new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr event stream closed.", true));
            return;
          }
          this.handleConnectionLoss(error);
        },
        () => {
          if (settled) return;
          ready = true;
          settled = true;
          queueMicrotask(() => resolve(stop));
        },
      );
      this.stopEvents = stop;
    });
  }

  private scheduleSnapshotRefresh(): void {
    if (this.refreshPromise) {
      this.refreshPending = true;
      return;
    }
    if (this.refreshTimer) return;
    const generation = this.generation;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSnapshot().catch((error) => {
        if (generation === this.generation && this.client) this.handleConnectionLoss(asHerdrError(error));
      });
    }, 100);
    this.refreshTimer.unref();
  }

  private markFleetStale(): void {
    if (this.fleet.stale) return;
    this.fleet = {
      ...this.fleet,
      revision: this.fleet.revision + 1,
      receivedAt: Math.max(Date.now(), this.fleet.receivedAt + 1),
      stale: true,
    };
    this.server.emit("herdr.fleet", "*", this.getFleet());
  }

  private scheduleReconnect(): void {
    if (!this.shouldAutoReconnect()) return;
    this.clearReconnect();
    const attempt = this.reconnectAttempt++;
    const baseDelay = Math.min(5_000, 250 * 2 ** Math.min(5, attempt));
    const delay = Math.max(
      1,
      Math.round(this.options.reconnectDelayMs?.(attempt) ?? baseDelay * (0.8 + Math.random() * 0.4)),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectForDesiredState();
    }, delay);
    this.reconnectTimer.unref();
  }

  private handleConnectionLoss(error?: HerdrBridgeError): void {
    void this.teardownConnection();
    const status = error ? this.failureStatus(error) : this.shouldAutoReconnect() ? "reconnecting" : "unavailable";
    this.setRuntime({
      ...this.runtimeFromDescriptor(this.descriptor),
      status,
      ...(error ? { error: error.toPublic() } : {}),
    });
    if (status === "reconnecting") this.scheduleReconnect();
  }

  private shouldAutoReconnect(): boolean {
    return (
      this.desiredConnection &&
      !this.manuallyDisconnected &&
      this.descriptor.enabled &&
      this.descriptor.autoConnect &&
      !this.descriptor.error
    );
  }

  private isIncompatibleError(error: HerdrBridgeError): boolean {
    return [
      "HERDR_VERSION_TOO_OLD",
      "HERDR_VERSION_UNSUPPORTED",
      "HERDR_PROTOCOL_UNSUPPORTED",
      "HERDR_SCHEMA_UNSUPPORTED",
    ].includes(error.code);
  }

  private isTerminalConnectionError(error: HerdrBridgeError): boolean {
    return ["HERDR_ENDPOINT_UNSAFE", "HERDR_SCHEMA_INVALID", "HERDR_PROTOCOL_LIMIT_EXCEEDED"].includes(error.code);
  }

  private failureStatus(error: HerdrBridgeError): "incompatible" | "error" | "reconnecting" | "unavailable" {
    if (this.isIncompatibleError(error)) return "incompatible";
    if (this.isTerminalConnectionError(error)) return "error";
    return this.shouldAutoReconnect() ? "reconnecting" : "unavailable";
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}
