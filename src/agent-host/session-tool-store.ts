import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SessionToolStoreLock } from "./session-tool-store-lock.ts";
import { RpcError } from "../contract/types";
import {
  DESKTOP_TOOL_POLICY_REVISION,
  filterDesktopToolNames,
  filterStoredToolNames,
} from "../shared/pi-tool-policy.ts";
import { desktopDataRoot } from "./desktop-data-root";
import { isAgentShell, useAgentShell, type AgentShell } from "../shared/agent-shell.ts";
import { isOrchestrationTool, ORCHESTRATION_TOOL_NAMES } from "../shared/orchestration-tools";
import { CODING_FULL_TOOLS } from "../shared/tool-presets";
import { mcpToolIdentity, validMcpToolIdentity, type NamedMcpTool } from "../shared/mcp-tool-identity";

type StoredSessionTools = {
  directoryForkOwner?: string;
  mcpApprovalRevision?: string;
  shell?: AgentShell;
  toolNames: string[];
  policyRevision?: number;
  executionToolNames?: string[];
  mcpExecutionToolNames?: string[];
  mcpDeclarationToolNames?: string[];
  orchestrationToolNames?: string[] | null;
  mcpToolIdentities?: Record<string, string>;
  updatedAt: string;
};

type SessionToolStateFile = {
  version: 1;
  sessions: Record<string, StoredSessionTools>;
  sameDirectoryBranches?: Record<string, { cwd: string; parentSession: string }>;
};

const EMPTY_STATE: SessionToolStateFile = { version: 1, sessions: {} };

function normalizeToolNames(
  value: unknown,
  platform: string,
  revision: unknown = DESKTOP_TOOL_POLICY_REVISION,
): string[] | undefined {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
  return filterStoredToolNames(value, revision, platform);
}

function normalizeState(value: unknown, platform: string): SessionToolStateFile {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const candidate = value as Partial<SessionToolStateFile>;
  if (candidate.version !== 1 || !candidate.sessions || typeof candidate.sessions !== "object") {
    return structuredClone(EMPTY_STATE);
  }
  const sessions: Record<string, StoredSessionTools> = Object.create(null);
  for (const [rawSessionId, rawEntry] of Object.entries(candidate.sessions)) {
    const sessionId = rawSessionId.trim();
    if (!sessionId || !rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Partial<StoredSessionTools>;
    const toolNames = normalizeToolNames(entry.toolNames, platform, entry.policyRevision ?? 0);
    if (toolNames === undefined) continue;
    sessions[sessionId] = {
      toolNames,
      ...(typeof entry.mcpApprovalRevision === "string" ? { mcpApprovalRevision: entry.mcpApprovalRevision } : {}),
      ...(platform === "win32" && isAgentShell(entry.shell) ? { shell: entry.shell } : {}),
      ...(entry.policyRevision === DESKTOP_TOOL_POLICY_REVISION ? { policyRevision: entry.policyRevision } : {}),
      ...(entry.executionToolNames === undefined
        ? {}
        : {
            executionToolNames: normalizeToolNames(entry.executionToolNames, platform, entry.policyRevision ?? 0) ?? [],
          }),
      ...(entry.mcpExecutionToolNames === undefined
        ? {}
        : {
            mcpExecutionToolNames:
              normalizeToolNames(entry.mcpExecutionToolNames, platform, entry.policyRevision ?? 0) ?? [],
          }),
      ...(entry.mcpDeclarationToolNames === undefined
        ? {}
        : {
            mcpDeclarationToolNames:
              normalizeToolNames(entry.mcpDeclarationToolNames, platform, entry.policyRevision ?? 0) ?? [],
          }),
      ...(entry.orchestrationToolNames === undefined
        ? {}
        : {
            orchestrationToolNames:
              entry.orchestrationToolNames === null
                ? null
                : (normalizeToolNames(entry.orchestrationToolNames, platform, entry.policyRevision ?? 0) ?? []).filter(
                    isOrchestrationTool,
                  ),
          }),
      updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : new Date(0).toISOString(),
      ...(entry.mcpToolIdentities && typeof entry.mcpToolIdentities === "object"
        ? {
            mcpToolIdentities: Object.fromEntries(
              Object.entries(entry.mcpToolIdentities).filter(
                ([name, identity]) => name.startsWith("mcp__") && validMcpToolIdentity(identity),
              ),
            ),
          }
        : {}),
    };
  }
  return { version: 1, sessions, sameDirectoryBranches: candidate.sameDirectoryBranches };
}

class InvalidToolPermissions extends Error {}

function readDocument(filePath: string, strict = false): { value: SessionToolStateFile; text?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { value: structuredClone(EMPTY_STATE) };
  }
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions))
      throw new Error("Unsupported tool permissions file");
    return { value, text };
  } catch (cause) {
    if (strict) throw new InvalidToolPermissions("Cannot safely update existing Desktop tool permissions", { cause });
    return { value: structuredClone(EMPTY_STATE), text };
  }
}

// A fork prepares its rollback before installing the new policy. Its transcript
// becomes visible in a synchronous callback while the permissions lock is held.
function atomicWrite(
  filePath: string,
  value: SessionToolStateFile,
  fork?: { previous?: string; publish: () => void; workspace?: string },
): void {
  const staging = fork?.workspace ?? mkdtempSync(path.join(path.dirname(filePath), ".pi-tool-state-"));
  const next = path.join(staging, "next");
  const previous = path.join(staging, "previous");
  let keepBackup = false;
  try {
    const options = { encoding: "utf8", mode: 0o600, flag: "wx", flush: true } as const;
    if (fork?.previous !== undefined) writeFileSync(previous, fork.previous, options);
    writeFileSync(next, JSON.stringify(value, null, 2), options);
    renameSync(next, filePath);
    try {
      fork?.publish();
    } catch (error) {
      try {
        if (fork?.previous !== undefined) renameSync(previous, filePath);
        else unlinkSync(filePath);
      } catch (rollbackError) {
        keepBackup = true;
        throw new AggregateError(
          [error, rollbackError],
          `Could not restore Desktop tool permissions. Backup: ${staging}`,
        );
      }
      throw error;
    }
  } finally {
    if (!keepBackup && !fork?.workspace) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch (error) {
        console.warn("[agent-host] failed to clean up staged tool permissions:", error);
      }
    }
  }
}

function chatOnlySelection(shell?: AgentShell): StoredSessionTools {
  return {
    mcpApprovalRevision: randomUUID(),
    toolNames: [],
    executionToolNames: [],
    mcpDeclarationToolNames: [],
    mcpExecutionToolNames: [],
    orchestrationToolNames: [],
    ...(shell ? { shell } : {}),
    policyRevision: DESKTOP_TOOL_POLICY_REVISION,
    updatedAt: new Date().toISOString(),
  };
}

// Additive approvals keep this revision. Explicit permission changes invalidate
// open dialogs, including a revocation that repeats the already-saved selection.
function approvalRevision(entry: StoredSessionTools | undefined): string {
  return (
    entry?.mcpApprovalRevision ??
    createHash("sha256")
      .update(
        JSON.stringify([entry?.toolNames, entry?.executionToolNames, entry?.mcpExecutionToolNames, entry?.updatedAt]),
      )
      .digest("hex")
  );
}

function orchestrationFor(entry: StoredSessionTools | undefined): string[] | undefined {
  if (!entry) return undefined;
  if (!entry.toolNames.length) return [];
  if (entry.orchestrationToolNames !== undefined)
    return entry.orchestrationToolNames === null ? undefined : [...entry.orchestrationToolNames];
  if (entry.mcpDeclarationToolNames !== undefined) return entry.mcpDeclarationToolNames.filter(isOrchestrationTool);
  const selected = entry.toolNames.filter(isOrchestrationTool);
  if (selected.length) return selected;
  if (
    entry.toolNames.length === CODING_FULL_TOOLS.length &&
    CODING_FULL_TOOLS.every((name) => entry.toolNames.includes(name))
  )
    return [...ORCHESTRATION_TOOL_NAMES];
}

type ToolMutation =
  | "rememberLegacyFork"
  | "set"
  | "setFromActive"
  | "setOrchestration"
  | "authorizeMcpSelection"
  | "setExecution"
  | "setMcpDeclaration"
  | "setMcpExecution"
  | "addMcpExecution"
  | "copyMcpIdentities";
type LockedMutations = { [K in ToolMutation]: (...args: Parameters<DesktopSessionToolStore[K]>) => void };

export class DesktopSessionToolStore {
  private cached?: { revision: string; state: SessionToolStateFile };
  private readonly mcpCatalogs = new Map<string, Map<string, string>>();

  readonly writeLock: SessionToolStoreLock;
  /** A group of mutations inside this store's synchronous critical section. */
  get locked(): LockedMutations {
    if (!this.writeLock.isHeld) throw new Error("Tool permission mutations require the store lock");
    return this;
  }

  constructor(
    private readonly filePath: string,
    private readonly platform = process.platform,
  ) {
    this.writeLock = new SessionToolStoreLock(filePath);
  }

  get(sessionId: string): string[] | undefined {
    const normalizedId = sessionId.trim();
    if (!normalizedId) return undefined;
    const entry = this.load().sessions[normalizedId];
    if (!entry) return;
    const selected = orchestrationFor(entry);
    return selected === undefined
      ? [...entry.toolNames]
      : [...entry.toolNames.filter((name) => !isOrchestrationTool(name)), ...selected];
  }

  /** SDK activation is not an explicit grant. Automatic snapshots may only retain previously approved shells. */
  filterActiveSelection(sessionId: string, names: readonly string[], requested?: readonly string[]): string[] {
    const authorized = requested ?? this.get(sessionId) ?? [];
    return filterDesktopToolNames(names, this.platform).filter(
      (name) => name !== "powershell" || authorized.includes(name),
    );
  }
  setFromActive(sessionId: string, names: readonly string[], requested?: readonly string[]): void | Promise<void> {
    return this.writeLock.run(() =>
      this.locked.set(sessionId, this.filterActiveSelection(sessionId, names, requested)),
    );
  }

  getShell(sessionId: string): AgentShell | undefined {
    return this.platform === "win32" ? this.load().sessions[sessionId.trim()]?.shell : undefined;
  }

  knowsSameDirectoryBranch(id: string, cwd: string, parentSession: string): boolean {
    const known = this.load().sameDirectoryBranches?.[id];
    return known?.cwd === cwd && known.parentSession === parentSession;
  }

  /** Automatic startup must not overwrite a concurrent choice or a permissions file it cannot interpret. */
  initialSelection(id: string, fallback: string[], shell?: AgentShell): string[] {
    if (!this.writeLock.isHeld) throw new Error("Tool permission initialization requires the store lock");
    let document;
    try {
      document = readDocument(this.filePath, true);
    } catch (error) {
      if (error instanceof InvalidToolPermissions) return [];
      throw error;
    }
    if (Object.keys(document.value.sessions).some((key) => key.trim() === id)) return this.get(id) ?? [];
    this.locked.set(id, fallback, shell);
    return this.get(id) ?? [];
  }

  /** Remember provenance on writable attach without turning a CLI tool loadout into a Desktop grant. */
  rememberLegacyFork(id: string, sameDirectory?: { cwd: string; parentSession: string }) {
    if (sameDirectory && this.knowsSameDirectoryBranch(id, sameDirectory.cwd, sameDirectory.parentSession)) return;
    return this.writeLock.run(() => {
      let document;
      try {
        document = readDocument(this.filePath, true);
      } catch (error) {
        if (error instanceof InvalidToolPermissions) return;
        throw error;
      }
      if (Object.keys(document.value.sessions).some((key) => key.trim() === id)) return;
      if (sameDirectory)
        document.value.sameDirectoryBranches = { ...document.value.sameDirectoryBranches, [id]: sameDirectory };
      else document.value.sessions[id] = chatOnlySelection();
      atomicWrite(this.filePath, document.value);
      this.cached = undefined;
    });
  }

  async publishChatOnlyFork(
    sessionId: string,
    shell: AgentShell | undefined,
    publish: () => void,
    workspace?: string,
  ): Promise<void> {
    await this.writeLock.run(() => {
      const { value, text } = readDocument(this.filePath, true);
      if (Object.keys(value.sessions).some((key) => key.trim() === sessionId))
        throw new RpcError({ code: "CONFLICT", message: "Tool permissions already exist for the fork ID." });
      const row = {
        ...chatOnlySelection(shell),
        ...(workspace ? { directoryForkOwner: path.basename(workspace) } : {}),
      };
      if (workspace)
        writeFileSync(path.join(workspace, "installing"), JSON.stringify(row), {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      value.sessions = { ...value.sessions, [sessionId]: row };
      atomicWrite(this.filePath, value, { previous: text, publish, workspace });
      this.cached = undefined;
    });
  }

  rollbackUnpublishedFork(sessionId: string, workspace: string): boolean {
    if (!this.writeLock.isHeld) throw new Error("Fork recovery requires the tool permissions lock");
    const { value } = readDocument(this.filePath, true);
    const row = value.sessions[sessionId];
    if (!row) return true;
    if (
      row?.directoryForkOwner !== path.basename(workspace) ||
      JSON.stringify(row) !== readFileSync(path.join(workspace, "installing"), "utf8")
    )
      return false;
    delete value.sessions[sessionId];
    const backup = path.join(workspace, "previous");
    const previous = readDocument(backup, true);
    // Preserve a concurrent writer's changes to other sessions. Restore exact
    // original bytes (or absence) when this fork was the only change.
    if (JSON.stringify(value) !== JSON.stringify(previous.value)) atomicWrite(this.filePath, value);
    else if (previous.text === undefined) unlinkSync(this.filePath);
    else renameSync(backup, this.filePath);
    this.cached = undefined;
    return true;
  }

  private update(sessionId: string, change: (state: SessionToolStateFile) => void, strict = false) {
    return this.writeLock.run(() => {
      const { value } = readDocument(this.filePath, strict);
      const state = normalizeState(value, this.platform);
      if (strict && !state.sessions[sessionId] && Object.keys(value.sessions).some((key) => key.trim() === sessionId))
        throw new InvalidToolPermissions("Cannot safely update existing Desktop tool permissions");
      const before = JSON.stringify(state.sessions[sessionId]);
      change(state);
      const entry = state.sessions[sessionId];
      if (!entry || JSON.stringify(entry) === before) return;
      // Normalize only the edited session on disk. Other sessions can contain
      // newer or legacy fields that this version does not understand.
      for (const key of Object.keys(value.sessions))
        if (key !== sessionId && key.trim() === sessionId) delete value.sessions[key];
      value.sessions = { ...value.sessions, [sessionId]: entry };
      atomicWrite(this.filePath, value);
      this.cached = undefined;
    });
  }

  set(sessionId: string, toolNames: string[], shell?: AgentShell): void | Promise<void> {
    const normalizedId = sessionId.trim();
    return this.update(normalizedId, (state) => {
      const previous = state.sessions[normalizedId];
      const selectedShell = this.platform === "win32" ? (shell ?? previous?.shell) : undefined;
      const normalizedToolNames = normalizeToolNames(useAgentShell(toolNames, selectedShell), this.platform);
      if (!normalizedId || normalizedToolNames === undefined) throw new Error("Invalid session tool state");
      if (normalizedToolNames.length === 0) {
        state.sessions[normalizedId] = {
          ...chatOnlySelection(selectedShell),
          ...(previous?.mcpToolIdentities ? { mcpToolIdentities: previous.mcpToolIdentities } : {}),
        };
        return;
      }
      const selected = normalizedToolNames.filter(isOrchestrationTool);
      const orchestration = selected.length
        ? selected
        : previous?.toolNames.length
          ? (orchestrationFor(previous) ?? (previous.orchestrationToolNames === null ? null : undefined))
          : undefined;
      state.sessions[normalizedId] = {
        toolNames: normalizedToolNames,
        mcpApprovalRevision: randomUUID(),
        ...(selectedShell ? { shell: selectedShell } : {}),
        policyRevision: DESKTOP_TOOL_POLICY_REVISION,
        ...(previous?.mcpToolIdentities ? { mcpToolIdentities: previous.mcpToolIdentities } : {}),
        ...(orchestration === undefined ? {} : { orchestrationToolNames: orchestration }),
        ...(previous?.toolNames.length && previous.mcpDeclarationToolNames !== undefined
          ? { mcpDeclarationToolNames: previous.mcpDeclarationToolNames }
          : {}),
        ...(previous?.toolNames.length && previous.mcpExecutionToolNames !== undefined
          ? { mcpExecutionToolNames: previous.mcpExecutionToolNames }
          : {}),
        ...(previous?.toolNames.length && previous.executionToolNames !== undefined
          ? { executionToolNames: previous.executionToolNames }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /** Called only from a writable, attached MCP session. JSONL is evidence, never rewritten. */
  observeMcpTools(
    sessionId: string,
    tools: readonly NamedMcpTool[],
    evidence: Record<string, string> = {},
  ): void | Promise<void> {
    const catalog = new Map(tools.map((tool) => [tool.name, mcpToolIdentity(tool)]));
    this.mcpCatalogs.set(sessionId, catalog);
    if (!this.load().sessions[sessionId]) return;
    return this.update(sessionId, (state) => {
      const entry = state.sessions[sessionId];
      if (!entry || this.mcpCatalogs.get(sessionId) !== catalog) return;
      const revision = approvalRevision(entry);
      const identities = { ...entry.mcpToolIdentities };
      const byIdentity = new Map([...catalog].map(([name, identity]) => [identity, name]));
      const renamed: Record<string, string> = {};
      // A declaration cannot establish the provenance of an execution grant with the same spelling.
      const granted = entry.mcpExecutionToolNames ?? entry.executionToolNames ?? entry.toolNames;
      const owner = (name: string) => identities[name] ?? evidence[name];
      const migrate = (name: string) => {
        const identity = owner(name);
        return name.startsWith("mcp__") && validMcpToolIdentity(identity) ? (byIdentity.get(identity) ?? name) : name;
      };
      const grants = granted.filter((name) => !name.startsWith("mcp__") || validMcpToolIdentity(owner(name)));
      for (const name of grants) {
        if (!name.startsWith("mcp__")) continue;
        const identity = owner(name)!;
        renamed[name] = identity;
        renamed[migrate(name)] = identity;
      }
      for (const key of [
        "toolNames",
        "executionToolNames",
        "mcpExecutionToolNames",
        "mcpDeclarationToolNames",
      ] as const) {
        const selected = entry[key];
        if (!selected) continue;
        entry[key] = [
          ...new Set(
            selected
              .filter(
                (name) =>
                  key !== "executionToolNames" || !name.startsWith("mcp__") || validMcpToolIdentity(owner(name)),
              )
              .map(migrate),
          ),
        ];
      }
      // Prevent unresolved legacy choices from falling through from active declarations.
      entry.mcpExecutionToolNames = entry.toolNames.length === 0 ? [] : [...new Set(grants.map(migrate))];
      entry.mcpToolIdentities = { ...identities, ...renamed };
      entry.mcpApprovalRevision = revision;
    });
  }
  mcpIdentityMatches(sessionId: string, name: string): boolean {
    const current = this.mcpCatalogs.get(sessionId)?.get(name);
    return current !== undefined && this.load().sessions[sessionId]?.mcpToolIdentities?.[name] === current;
  }
  mcpGrantRevision(id: string): string {
    return approvalRevision(this.load().sessions[id]);
  }

  mcpGrantAllows(id: string, name: string): boolean {
    const entry = this.load().sessions[id];
    if (!entry?.toolNames.length) return false;
    const grants = entry.mcpExecutionToolNames ?? entry.executionToolNames ?? entry.toolNames;
    return grants.includes(name) && (!name.startsWith("mcp__") || this.mcpIdentityMatches(id, name));
  }

  captureMcpSelection(id: string, names: readonly string[]): () => boolean {
    const catalog = this.mcpCatalogs.get(id);
    const chosen = names.filter((n) => n.startsWith("mcp__")).map((n) => [n, catalog?.get(n)] as const);
    return () => chosen.every(([name, identity]) => this.mcpCatalogs.get(id)?.get(name) === identity);
  }
  mcpUpdatedAt(sessionId: string): string | undefined {
    return this.load().sessions[sessionId]?.updatedAt;
  }
  unverifiedMcpTools(sessionId: string): string[] {
    const entry = this.load().sessions[sessionId];
    if (!entry) return [];
    return [
      ...new Set(
        (entry.mcpExecutionToolNames ?? entry.executionToolNames ?? entry.toolNames).filter(
          (name) => name.startsWith("mcp__") && !entry.mcpToolIdentities?.[name],
        ),
      ),
    ];
  }
  forgetMcpCatalog(sessionId: string): void {
    this.mcpCatalogs.delete(sessionId);
  }
  authorizeMcpSelection(sessionId: string, names: readonly string[]): void | Promise<void> {
    return this.update(sessionId, (state) => this.bindMcpSelection(state.sessions[sessionId], sessionId, names));
  }
  copyMcpIdentities(sourceId: string, targetId: string): void | Promise<void> {
    return this.update(targetId, (state) => {
      const source = state.sessions[sourceId],
        target = state.sessions[targetId];
      if (target && source?.mcpToolIdentities) target.mcpToolIdentities = { ...source.mcpToolIdentities };
    });
  }
  private bindMcpSelection(entry: StoredSessionTools | undefined, sessionId: string, names: readonly string[]): void {
    const catalog = this.mcpCatalogs.get(sessionId);
    if (!entry || !catalog) return;
    for (const name of names) {
      const identity = catalog.get(name);
      if (identity) (entry.mcpToolIdentities ??= {})[name] = identity;
    }
  }

  private load(): SessionToolStateFile {
    const stat = statSync(this.filePath, { throwIfNoEntry: false, bigint: true });
    const revision = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "";
    if (this.cached?.revision !== revision) {
      this.cached = { revision, state: normalizeState(readDocument(this.filePath).value, this.platform) };
    }
    return this.cached.state;
  }

  getExecution(sessionId: string): string[] | undefined {
    const names = this.load().sessions[sessionId.trim()]?.executionToolNames;
    return names ? [...names] : undefined;
  }
  getMcpExecution(sessionId: string): string[] | undefined {
    const names = this.load().sessions[sessionId.trim()]?.mcpExecutionToolNames;
    return names ? [...names] : undefined;
  }
  getMcpDeclaration(sessionId: string): string[] | undefined {
    const names = this.load().sessions[sessionId.trim()]?.mcpDeclarationToolNames;
    return names ? [...names] : undefined;
  }
  getOrchestration(sessionId: string): string[] | undefined {
    return orchestrationFor(this.load().sessions[sessionId.trim()]);
  }
  setOrchestration(sessionId: string, names: string[]): void | Promise<void> {
    return this.update(sessionId.trim(), (state) => {
      const entry = state.sessions[sessionId.trim()];
      if (!entry || !entry.toolNames.length) throw new Error("Enable a session tool preset before orchestration tools");
      const selected = normalizeToolNames(names, this.platform);
      if (!selected || selected.some((name) => !isOrchestrationTool(name)))
        throw new Error("Invalid orchestration tool selection");
      entry.orchestrationToolNames = selected;
      entry.toolNames = [...entry.toolNames.filter((name) => !isOrchestrationTool(name)), ...selected];
      entry.updatedAt = new Date().toISOString();
    });
  }
  setMcpDeclaration(sessionId: string, names: string[]): void | Promise<void> {
    return this.update(sessionId.trim(), (state) => {
      const entry = state.sessions[sessionId.trim()];
      if (!entry) throw new Error("Missing session tool selection");
      if (entry.orchestrationToolNames === undefined) entry.orchestrationToolNames = orchestrationFor(entry) ?? null;
      entry.mcpDeclarationToolNames = entry.toolNames.length === 0 ? [] : [...names];
      entry.updatedAt = new Date().toISOString();
    });
  }
  setMcpExecution(sessionId: string, names: string[]): void | Promise<void> {
    return this.update(sessionId.trim(), (state) => {
      const entry = state.sessions[sessionId.trim()];
      if (!entry) throw new Error("Session tool selection must be saved before MCP grants");
      entry.mcpApprovalRevision = randomUUID();
      entry.mcpExecutionToolNames = entry.toolNames.length === 0 ? [] : filterDesktopToolNames(names, this.platform);
      this.bindMcpSelection(entry, sessionId, names);
      entry.updatedAt = new Date().toISOString();
    });
  }

  addMcpExecution(id: string, names: string[], active: string[], allowed: string[]): void | Promise<void> {
    return this.update(
      id,
      (state) => {
        const previous = state.sessions[id];
        const revision = approvalRevision(previous);
        const entry = previous ?? {
          toolNames: this.filterActiveSelection(id, active),
          policyRevision: DESKTOP_TOOL_POLICY_REVISION,
          updatedAt: "",
        };
        if (!entry.toolNames.length)
          throw new RpcError({ code: "CONFLICT", message: "Enable a session tool preset before granting MCP tools" });
        const retained =
          entry.mcpExecutionToolNames ??
          entry.executionToolNames ??
          allowed.filter((name) => entry.toolNames.includes(name));
        entry.mcpExecutionToolNames = [...new Set([...retained, ...filterDesktopToolNames(names, this.platform)])];
        entry.mcpApprovalRevision = revision;
        this.bindMcpSelection(entry, id, names);
        entry.updatedAt = new Date().toISOString();
        state.sessions[id] = entry;
      },
      true,
    );
  }
  setExecution(sessionId: string, names: string[]): void | Promise<void> {
    return this.update(sessionId.trim(), (state) => {
      const entry = state.sessions[sessionId.trim()];
      if (!entry) throw new Error("Session tool selection must be saved before execution grants");
      entry.mcpApprovalRevision = randomUUID();
      entry.executionToolNames = entry.toolNames.length === 0 ? [] : filterDesktopToolNames(names, this.platform);
      this.bindMcpSelection(entry, sessionId, names);
      delete entry.mcpExecutionToolNames;
      entry.updatedAt = new Date().toISOString();
    });
  }
}

let defaultStore: DesktopSessionToolStore | undefined;

export function getDefaultStore(): DesktopSessionToolStore {
  defaultStore ??= new DesktopSessionToolStore(path.join(desktopDataRoot(), "session-tools.json"));
  return defaultStore;
}

export function getDesktopSessionToolNames(sessionId: string): string[] | undefined {
  return getDefaultStore().get(sessionId);
}

export function setDesktopSessionToolNames(sessionId: string, toolNames: string[], shell?: AgentShell) {
  return getDefaultStore().set(sessionId, toolNames, shell);
}

export function getDesktopSessionExecutionTools(sessionId: string): string[] | undefined {
  return getDefaultStore().getExecution(sessionId);
}
export function setDesktopSessionExecutionTools(sessionId: string, names: string[]) {
  return getDefaultStore().setExecution(sessionId, names);
}
export function getDesktopSessionMcpExecutionTools(sessionId: string): string[] | undefined {
  return getDefaultStore().getMcpExecution(sessionId);
}
export function setDesktopSessionMcpExecutionTools(sessionId: string, names: string[]) {
  return getDefaultStore().setMcpExecution(sessionId, names);
}
export function getDesktopSessionMcpDeclarations(sessionId: string): string[] | undefined {
  return getDefaultStore().getMcpDeclaration(sessionId);
}
export function setDesktopSessionMcpDeclarations(sessionId: string, names: string[]) {
  return getDefaultStore().setMcpDeclaration(sessionId, names);
}
export function copyDesktopMcpTools(sourceId: string, targetId: string) {
  const store = getDefaultStore();
  return store.writeLock.run(() => {
    const shell = store.getShell(sourceId);
    if (shell) store.locked.set(targetId, store.get(targetId) ?? [], shell);
    const grants = getDesktopSessionMcpExecutionTools(sourceId),
      declarations = getDesktopSessionMcpDeclarations(sourceId);
    if (grants) store.locked.setMcpExecution(targetId, grants);
    if (declarations) store.locked.setMcpDeclaration(targetId, declarations);
    store.locked.copyMcpIdentities(sourceId, targetId);
    const orchestration = store.getOrchestration(sourceId);
    if (orchestration && store.get(targetId)?.length) store.locked.setOrchestration(targetId, orchestration);
  });
}
