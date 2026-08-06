import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionInfo } from "../shared/types";
import { buildSessionInfoFromManager } from "./session-reader";
import { getProjectCacheRevision, resolveProject } from "../shared/worktree";

const PROJECT_VIEW_TTL_MS = 60_000;

interface Fingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface IndexRecord {
  filePath: string;
  fingerprint: Fingerprint;
  info: SessionInfo | null;
  parentPath?: string;
  valid: boolean;
}

export interface SessionIndexMetrics {
  filesDiscovered: number;
  filesParsed: number;
  filesReused: number;
  invalidFiles: number;
  totalMs: number;
}

function fingerprint(filePath: string): Fingerprint {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino
  );
}

function discoverSessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
    }
  }
  return files;
}

export class SessionIndex {
  private readonly byPath = new Map<string, IndexRecord>();
  private readonly pathById = new Map<string, string>();
  private refreshPromise: Promise<void> | null = null;
  private initialized = false;
  private projectRevision = -1;
  private projectViewsRefreshedAt = 0;
  private metrics: SessionIndexMetrics = {
    filesDiscovered: 0,
    filesParsed: 0,
    filesReused: 0,
    invalidFiles: 0,
    totalMs: 0,
  };

  private sessionsRoot(): string {
    return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR || path.join(getAgentDir(), "sessions"));
  }

  private rebuildDerivedState(): void {
    this.pathById.clear();
    const idByPath = new Map<string, string>();
    for (const record of this.byPath.values()) {
      if (record.info) {
        this.pathById.set(record.info.id, record.filePath);
        idByPath.set(record.filePath, record.info.id);
      }
    }
    for (const record of this.byPath.values()) {
      if (!record.info) continue;
      const parentSessionId = record.parentPath ? idByPath.get(record.parentPath) : undefined;
      record.info = {
        ...record.info,
        ...(parentSessionId ? { parentSessionId } : { parentSessionId: undefined }),
      };
    }
  }

  private async refreshProjectViews(): Promise<void> {
    const revision = getProjectCacheRevision();
    if (revision === this.projectRevision && Date.now() - this.projectViewsRefreshedAt < PROJECT_VIEW_TTL_MS) return;
    const projects = new Map<string, Awaited<ReturnType<typeof resolveProject>>>();
    await Promise.all(
      [...new Set([...this.byPath.values()].flatMap((record) => (record.info?.cwd ? [record.info.cwd] : [])))].map(
        async (cwd) => {
          projects.set(cwd, await resolveProject(cwd));
        },
      ),
    );
    for (const record of this.byPath.values()) {
      if (!record.info) continue;
      const project = projects.get(record.info.cwd);
      if (!project) continue;
      const { worktreeBranch: _worktreeBranch, ...base } = record.info;
      record.info = {
        ...base,
        projectRoot: project.projectRoot,
        ...(project.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
      };
    }
    this.projectRevision = revision;
    this.projectViewsRefreshedAt = Date.now();
  }

  private async parsePath(
    filePath: string,
    currentFingerprint: Fingerprint,
    resolveProjectInfo: boolean,
  ): Promise<IndexRecord> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = attempt === 0 ? currentFingerprint : fingerprint(filePath);
      try {
        const manager = SessionManager.open(filePath);
        const entries = manager.getEntries() as unknown as SessionEntry[];
        const header = manager.getHeader();
        const info = await buildSessionInfoFromManager(filePath, manager, entries, { resolveProjectInfo });
        const after = fingerprint(filePath);
        if (!sameFingerprint(before, after)) {
          if (attempt === 0) continue;
          throw new Error("session changed during index parse");
        }
        return {
          filePath,
          fingerprint: after,
          info,
          parentPath: header?.parentSession,
          valid: Boolean(info),
        };
      } catch {
        if (attempt === 0) {
          try {
            const after = fingerprint(filePath);
            if (!sameFingerprint(before, after)) continue;
          } catch {
            // File disappeared; the invalid record is removed on the next discovery pass.
          }
        }
        return { filePath, fingerprint: before, info: null, valid: false };
      }
    }
    return { filePath, fingerprint: currentFingerprint, info: null, valid: false };
  }

  initialize(): Promise<void> {
    return this.refreshAll();
  }

  refreshAll(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const startedAt = performance.now();
      const files = discoverSessionFiles(this.sessionsRoot());
      const discovered = new Set(files);
      let filesParsed = 0;
      let filesReused = 0;
      let invalidFiles = 0;

      for (const existingPath of [...this.byPath.keys()]) {
        if (!discovered.has(existingPath)) this.byPath.delete(existingPath);
      }
      for (const filePath of files) {
        let currentFingerprint: Fingerprint;
        try {
          currentFingerprint = fingerprint(filePath);
        } catch {
          continue;
        }
        const existing = this.byPath.get(filePath);
        if (existing && sameFingerprint(existing.fingerprint, currentFingerprint)) {
          filesReused += 1;
          if (!existing.valid) invalidFiles += 1;
          continue;
        }
        const record = await this.parsePath(filePath, currentFingerprint, false);
        this.byPath.set(filePath, record);
        filesParsed += 1;
        if (!record.valid) invalidFiles += 1;
      }
      this.rebuildDerivedState();
      if (filesParsed > 0) this.projectViewsRefreshedAt = 0;
      this.initialized = true;
      this.metrics = {
        filesDiscovered: files.length,
        filesParsed,
        filesReused,
        invalidFiles,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      };
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async refreshPath(filePath: string): Promise<SessionInfo | null> {
    const resolved = path.resolve(filePath);
    const root = this.sessionsRoot();
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    if (!resolved.endsWith(".jsonl") || !existsSync(resolved)) {
      this.removePath(resolved);
      return null;
    }
    let currentFingerprint: Fingerprint;
    try {
      currentFingerprint = fingerprint(resolved);
    } catch {
      this.removePath(resolved);
      return null;
    }
    const existing = this.byPath.get(resolved);
    if (existing && sameFingerprint(existing.fingerprint, currentFingerprint)) return existing.info;
    const startedAt = performance.now();
    const record = await this.parsePath(resolved, currentFingerprint, true);
    this.byPath.set(resolved, record);
    this.rebuildDerivedState();
    this.initialized = true;
    this.metrics = {
      filesDiscovered: 1,
      filesParsed: 1,
      filesReused: 0,
      invalidFiles: record.valid ? 0 : 1,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
    return record.info;
  }

  removePath(filePath: string): SessionInfo | null {
    const existing = this.byPath.get(path.resolve(filePath));
    this.byPath.delete(path.resolve(filePath));
    this.rebuildDerivedState();
    return existing?.info ?? null;
  }

  getByPath(filePath: string): SessionInfo | null {
    return this.byPath.get(path.resolve(filePath))?.info ?? null;
  }

  async getAll(): Promise<SessionInfo[]> {
    if (!this.initialized) await this.initialize();
    await this.refreshProjectViews();
    return [...this.byPath.values()]
      .flatMap((record) => (record.info ? [record.info] : []))
      .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
  }

  async resolvePath(sessionId: string): Promise<string | null> {
    if (!this.initialized) await this.initialize();
    const known = this.pathById.get(sessionId);
    if (known) return known;
    await this.refreshAll();
    return this.pathById.get(sessionId) ?? null;
  }

  getMetrics(): SessionIndexMetrics {
    return { ...this.metrics };
  }
}

export const sessionIndex = new SessionIndex();
