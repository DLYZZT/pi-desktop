import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type StoredSessionTools = {
  toolNames: string[];
  updatedAt: string;
};

type SessionToolStateFile = {
  version: 1;
  sessions: Record<string, StoredSessionTools>;
};

const EMPTY_STATE: SessionToolStateFile = { version: 1, sessions: {} };

function normalizeToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) return undefined;
  return [...new Set(value.map((name) => name.trim()).filter(Boolean))];
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
    return entry ? [...entry.toolNames] : undefined;
  }

  set(sessionId: string, toolNames: string[]): void {
    const normalizedId = sessionId.trim();
    const normalizedToolNames = normalizeToolNames(toolNames);
    if (!normalizedId || normalizedToolNames === undefined) throw new Error("Invalid session tool state");
    const state = this.load();
    state.sessions[normalizedId] = {
      toolNames: normalizedToolNames,
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
}

function desktopUserDataPath(): string {
  return (
    process.env.PI_DESKTOP_USER_DATA?.trim() ||
    (process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "desktop") : "") ||
    path.join(homedir(), ".pi", "desktop")
  );
}

let defaultStore: DesktopSessionToolStore | undefined;

function getDefaultStore(): DesktopSessionToolStore {
  defaultStore ??= new DesktopSessionToolStore(path.join(desktopUserDataPath(), "session-tools.json"));
  return defaultStore;
}

export function getDesktopSessionToolNames(sessionId: string): string[] | undefined {
  return getDefaultStore().get(sessionId);
}

export function setDesktopSessionToolNames(sessionId: string, toolNames: string[]): void {
  getDefaultStore().set(sessionId, toolNames);
}
