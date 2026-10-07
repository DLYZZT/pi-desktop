import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filterDesktopToolNames } from "../shared/pi-tool-policy.ts";
import { desktopDataRoot } from "./desktop-data-root";
import { isOrchestrationTool, ORCHESTRATION_TOOL_NAMES } from "../shared/orchestration-tools";
import { CODING_FULL_TOOLS } from "../shared/tool-presets";
import { mcpToolIdentity, validMcpToolIdentity, type NamedMcpTool } from "../shared/mcp-tool-identity";

type StoredSessionTools = {
  toolNames: string[];
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
};

const EMPTY_STATE: SessionToolStateFile = { version: 1, sessions: {} };

function normalizeToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
  return filterDesktopToolNames(value);
}

function normalizeState(value: unknown): SessionToolStateFile {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const candidate = value as Partial<SessionToolStateFile>;
  if (candidate.version !== 1 || !candidate.sessions || typeof candidate.sessions !== "object") {
    return structuredClone(EMPTY_STATE);
  }
  const sessions: Record<string, StoredSessionTools> = {};
  for (const [rawSessionId, rawEntry] of Object.entries(candidate.sessions)) {
    const sessionId = rawSessionId.trim();
    if (!sessionId || !rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Partial<StoredSessionTools>;
    const toolNames = normalizeToolNames(entry.toolNames);
    if (toolNames === undefined) continue;
    sessions[sessionId] = {
      toolNames,
      ...(entry.executionToolNames === undefined
        ? {}
        : { executionToolNames: normalizeToolNames(entry.executionToolNames) ?? [] }),
      ...(entry.mcpExecutionToolNames === undefined
        ? {}
        : { mcpExecutionToolNames: normalizeToolNames(entry.mcpExecutionToolNames) ?? [] }),
      ...(entry.mcpDeclarationToolNames === undefined
        ? {}
        : { mcpDeclarationToolNames: normalizeToolNames(entry.mcpDeclarationToolNames) ?? [] }),
      ...(entry.orchestrationToolNames === undefined
        ? {}
        : {
            orchestrationToolNames:
              entry.orchestrationToolNames === null
                ? null
                : (normalizeToolNames(entry.orchestrationToolNames) ?? []).filter(isOrchestrationTool),
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
  return { version: 1, sessions };
}

function atomicWrite(filePath: string, value: SessionToolStateFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporaryPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

export class DesktopSessionToolStore {
  private state: SessionToolStateFile | undefined;
  private readonly mcpCatalogs = new Map<string, Map<string, string>>();

  constructor(private readonly filePath: string) {}

  get(sessionId: string): string[] | undefined {
    const normalizedId = sessionId.trim();
    if (!normalizedId) return undefined;
    const entry = this.load().sessions[normalizedId];
    if (!entry) return;
    const selected = this.getOrchestration(sessionId);
    return selected === undefined
      ? [...entry.toolNames]
      : [...entry.toolNames.filter((name) => !isOrchestrationTool(name)), ...selected];
  }

  set(sessionId: string, toolNames: string[]): void {
    const normalizedId = sessionId.trim();
    const normalizedToolNames = normalizeToolNames(toolNames);
    if (!normalizedId || normalizedToolNames === undefined) throw new Error("Invalid session tool state");
    const state = this.load();
    const previous = state.sessions[normalizedId];
    const selected = normalizedToolNames.filter(isOrchestrationTool);
    const orchestration =
      normalizedToolNames.length === 0
        ? []
        : selected.length
          ? selected
          : previous?.toolNames.length
            ? (this.getOrchestration(normalizedId) ?? (previous.orchestrationToolNames === null ? null : undefined))
            : undefined;
    state.sessions[normalizedId] = {
      toolNames: normalizedToolNames,
      ...(previous?.mcpToolIdentities ? { mcpToolIdentities: previous.mcpToolIdentities } : {}),
      ...(orchestration === undefined ? {} : { orchestrationToolNames: orchestration }),
      ...(normalizedToolNames.length === 0
        ? { mcpDeclarationToolNames: [] }
        : state.sessions[normalizedId]?.mcpDeclarationToolNames !== undefined &&
            state.sessions[normalizedId].toolNames.length !== 0
          ? { mcpDeclarationToolNames: state.sessions[normalizedId].mcpDeclarationToolNames }
          : {}),
      ...(normalizedToolNames.length === 0
        ? { mcpExecutionToolNames: [] }
        : state.sessions[normalizedId]?.mcpExecutionToolNames !== undefined &&
            state.sessions[normalizedId].toolNames.length !== 0
          ? { mcpExecutionToolNames: state.sessions[normalizedId].mcpExecutionToolNames }
          : {}),
      ...(normalizedToolNames.length === 0
        ? { executionToolNames: [] }
        : state.sessions[normalizedId]?.executionToolNames !== undefined &&
            state.sessions[normalizedId].toolNames.length !== 0
          ? { executionToolNames: state.sessions[normalizedId].executionToolNames }
          : {}),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.filePath, state);
  }

  /** Called only from a writable, attached MCP session. JSONL is evidence, never rewritten. */
  observeMcpTools(sessionId: string, tools: readonly NamedMcpTool[], evidence: Record<string, string> = {}): void {
    const catalog = new Map(tools.map((tool) => [tool.name, mcpToolIdentity(tool)]));
    this.mcpCatalogs.set(sessionId, catalog);
    const entry = this.load().sessions[sessionId];
    if (!entry) return;
    const before = JSON.stringify(entry);
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
              (name) => key !== "executionToolNames" || !name.startsWith("mcp__") || validMcpToolIdentity(owner(name)),
            )
            .map(migrate),
        ),
      ];
    }
    // Prevent unresolved legacy choices from falling through from active declarations.
    entry.mcpExecutionToolNames = entry.toolNames.length === 0 ? [] : [...new Set(grants.map(migrate))];
    entry.mcpToolIdentities = { ...identities, ...renamed };
    if (JSON.stringify(entry) !== before) atomicWrite(this.filePath, this.load());
  }
  mcpIdentityMatches(sessionId: string, name: string): boolean {
    const current = this.mcpCatalogs.get(sessionId)?.get(name);
    return current !== undefined && this.load().sessions[sessionId]?.mcpToolIdentities?.[name] === current;
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
  authorizeMcpSelection(sessionId: string, names: readonly string[]): void {
    const before = JSON.stringify(this.load().sessions[sessionId]);
    this.bindMcpSelection(sessionId, names);
    if (JSON.stringify(this.load().sessions[sessionId]) !== before) atomicWrite(this.filePath, this.load());
  }
  copyMcpIdentities(sourceId: string, targetId: string): void {
    const source = this.load().sessions[sourceId],
      target = this.load().sessions[targetId];
    if (!target || !source?.mcpToolIdentities) return;
    target.mcpToolIdentities = { ...source.mcpToolIdentities };
    atomicWrite(this.filePath, this.load());
  }
  private bindMcpSelection(sessionId: string, names: readonly string[]): void {
    const entry = this.load().sessions[sessionId],
      catalog = this.mcpCatalogs.get(sessionId);
    if (!entry || !catalog) return;
    for (const name of names) {
      const identity = catalog.get(name);
      if (identity) (entry.mcpToolIdentities ??= {})[name] = identity;
    }
  }

  private load(): SessionToolStateFile {
    if (this.state) return this.state;
    try {
      this.state = normalizeState(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.state = structuredClone(EMPTY_STATE);
    }
    return this.state;
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
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry) return;
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
  setOrchestration(sessionId: string, names: string[]): void {
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry || !entry.toolNames.length) throw new Error("Enable a session tool preset before orchestration tools");
    const selected = normalizeToolNames(names);
    if (!selected || selected.some((name) => !isOrchestrationTool(name)))
      throw new Error("Invalid orchestration tool selection");
    entry.orchestrationToolNames = selected;
    entry.toolNames = [...entry.toolNames.filter((name) => !isOrchestrationTool(name)), ...selected];
    entry.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, this.load());
  }
  setMcpDeclaration(sessionId: string, names: string[]): void {
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry) throw new Error("Missing session tool selection");
    if (entry.orchestrationToolNames === undefined)
      entry.orchestrationToolNames = this.getOrchestration(sessionId) ?? null;
    entry.mcpDeclarationToolNames = entry.toolNames.length === 0 ? [] : [...names];
    entry.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, this.load());
  }
  setMcpExecution(sessionId: string, names: string[]): void {
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry) throw new Error("Session tool selection must be saved before MCP grants");
    entry.mcpExecutionToolNames = entry.toolNames.length === 0 ? [] : filterDesktopToolNames(names);
    this.bindMcpSelection(sessionId, names);
    entry.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, this.load());
  }
  setExecution(sessionId: string, names: string[]): void {
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry) throw new Error("Session tool selection must be saved before execution grants");
    entry.executionToolNames = entry.toolNames.length === 0 ? [] : filterDesktopToolNames(names);
    this.bindMcpSelection(sessionId, names);
    delete entry.mcpExecutionToolNames;
    entry.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, this.load());
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

export function setDesktopSessionToolNames(sessionId: string, toolNames: string[]): void {
  getDefaultStore().set(sessionId, toolNames);
}

export function getDesktopSessionExecutionTools(sessionId: string): string[] | undefined {
  return getDefaultStore().getExecution(sessionId);
}
export function setDesktopSessionExecutionTools(sessionId: string, names: string[]): void {
  getDefaultStore().setExecution(sessionId, names);
}
export function getDesktopSessionMcpExecutionTools(sessionId: string): string[] | undefined {
  return getDefaultStore().getMcpExecution(sessionId);
}
export function setDesktopSessionMcpExecutionTools(sessionId: string, names: string[]): void {
  getDefaultStore().setMcpExecution(sessionId, names);
}
export function getDesktopSessionMcpDeclarations(sessionId: string): string[] | undefined {
  return getDefaultStore().getMcpDeclaration(sessionId);
}
export function setDesktopSessionMcpDeclarations(sessionId: string, names: string[]): void {
  getDefaultStore().setMcpDeclaration(sessionId, names);
}
export function copyDesktopMcpTools(sourceId: string, targetId: string): void {
  const grants = getDesktopSessionMcpExecutionTools(sourceId),
    declarations = getDesktopSessionMcpDeclarations(sourceId);
  if (grants) setDesktopSessionMcpExecutionTools(targetId, grants);
  if (declarations) setDesktopSessionMcpDeclarations(targetId, declarations);
  getDefaultStore().copyMcpIdentities(sourceId, targetId);
  const orchestration = getDefaultStore().getOrchestration(sourceId);
  if (orchestration && getDefaultStore().get(targetId)?.length)
    getDefaultStore().setOrchestration(targetId, orchestration);
}
