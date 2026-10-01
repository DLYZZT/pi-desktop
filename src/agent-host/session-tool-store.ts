import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filterDesktopToolNames } from "../shared/pi-tool-policy.ts";
import { desktopDataRoot } from "./desktop-data-root";
import { isOrchestrationTool, ORCHESTRATION_TOOL_NAMES } from "../shared/orchestration-tools";
import { CODING_FULL_TOOLS } from "../shared/tool-presets";

type StoredSessionTools = {
  toolNames: string[];
  executionToolNames?: string[];
  mcpExecutionToolNames?: string[];
  mcpDeclarationToolNames?: string[];
  orchestrationToolNames?: string[] | null;
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
    entry.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, this.load());
  }
  setExecution(sessionId: string, names: string[]): void {
    const entry = this.load().sessions[sessionId.trim()];
    if (!entry) throw new Error("Session tool selection must be saved before execution grants");
    entry.executionToolNames = entry.toolNames.length === 0 ? [] : filterDesktopToolNames(names);
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
  const orchestration = getDefaultStore().getOrchestration(sourceId);
  if (orchestration && getDefaultStore().get(targetId)?.length)
    getDefaultStore().setOrchestration(targetId, orchestration);
}
