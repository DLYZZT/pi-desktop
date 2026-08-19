/**
 * Register all Api handlers on the RPC server.
 * Implements the desktop RPC contract in the Agent Host process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import {
  DefaultResourceLoader,
  CredentialSynchronizationError,
  ModelRuntime,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import type { RpcServer } from "../contract/rpc";
import {
  RpcError,
  type HistoryWindow,
  type ModelInfo,
  type ModelCatalogStatus,
  type ModelCatalogWarning,
  type ModelPreferencesResult,
  type ModelsListResult,
  type SessionDetail,
  type SessionRuntimeState,
} from "../contract/types";
import type { SessionTreeNode } from "../shared/types";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import {
  disposeAllRpcSessions,
  getRpcSession,
  getRunningRpcSessionIds,
  startRpcSession,
  subscribeRunningSessions,
} from "./rpc-manager";
import {
  buildSessionContext,
  buildSessionInfoFromManager,
  getSessionIndexMetrics,
  cacheSessionPath,
  invalidateSessionPathCache,
  listAllSessions,
  resolveSessionPath,
} from "./session-reader";
import { isFilePathReferencedBySession } from "./session-file-references";
import { forkAppendArchived } from "./fork/archive";
import { relocateSessionFile } from "./session-relocate";
import {
  addWorktree,
  getGitStatus,
  isDirtyWorktreeError,
  listGitFiles,
  listWorktrees,
  removeWorktree,
  resolveProject,
} from "../shared/worktree";
import { buildEntriesFromFiles, filterFileEntries } from "../shared/file-fuzzy";
import {
  DOCX_PREVIEW_MAX_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getImageMime,
} from "../shared/file-types";
import { createFileWatchService, stopAllFileWatches } from "./file-watch";
import { callMain } from "./parent-rpc";
import { createAuthLoginService, resolveLoginCode } from "./auth-login";
import { getSharedModelRuntime, modelCatalogRefreshCoordinator, reloadSharedModelRuntimeConfig } from "./model-runtime";
import { applyPluginAction, readPlugins } from "./plugins-service";
import { installSkill, searchSkills } from "./skills-service";
import { updateSkillModelInvocation } from "./skill-frontmatter";
import { projectSessionTreeForResponse } from "./project-tree";
import { ChannelManager } from "./channels/channel-manager";
import { safeChannelError } from "./channels/redaction";
import { ToolchainError } from "../shared/toolchains/errors";
import { toolchainRuntime } from "./toolchain-runtime";
import {
  logSessionPerformance,
  resolveSessionTraceId,
  roundSessionMilliseconds,
  sessionPerformanceBytesEnabled,
} from "./session-performance";
import {
  buildHistoryRevision,
  buildSessionHistoryPage,
  decodeHistoryCursor,
  readSessionEntryContent,
  StaleHistoryCursorError,
} from "./session-history";
import { getSessionContentSnapshot, invalidateSessionContent } from "./session-content-cache";
import { sessionIndex } from "./session-index";
import { credentialStateMatches, recoverCommittedCredential, type CredentialTarget } from "./credential-sync";

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  txt: "text",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

async function emitIndexedSessionChange(server: RpcServer, sessionId: string, cwd: string | null): Promise<void> {
  try {
    const filePath = await resolveSessionPath(sessionId);
    const session = filePath ? await sessionIndex.refreshPath(filePath) : null;
    if (session) {
      server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
      return;
    }
  } catch (error) {
    console.error("[agent-host] failed to refresh changed session:", error);
  }
  server.emit("sessions.changed", "*", { cwd, fullRefresh: true });
}

async function assertPathAllowed(target: string, sourceSessionId?: string): Promise<void> {
  const allowed = await getAllowedFileRoots();
  if (isFilePathAllowed(target, allowed)) return;
  if (sourceSessionId && (await isFilePathReferencedBySession(target, sourceSessionId))) return;
  throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
}

function getModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

type ModelsFileSnapshot = { raw: string | null; version: string };

function modelsContentVersion(raw: string | null): string {
  return raw === null ? "missing" : `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function readModelsFileSnapshot(): ModelsFileSnapshot {
  const p = getModelsPath();
  if (!existsSync(p)) return { raw: null, version: modelsContentVersion(null) };
  const raw = readFileSync(p, "utf8");
  return { raw, version: modelsContentVersion(raw) };
}

function readModelsJsonSnapshot(): { config: Record<string, unknown>; version: string } {
  const snapshot = readModelsFileSnapshot();
  if (snapshot.raw === null) return { config: { providers: {} }, version: snapshot.version };
  try {
    return { config: JSON.parse(snapshot.raw) as Record<string, unknown>, version: snapshot.version };
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse models.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function modelsConfigConflict(expectedVersion: string, currentVersion: string): RpcError {
  return new RpcError({
    code: "CONFLICT",
    message: "models.json changed outside this editor; current edits were not saved",
    detail: { expectedVersion, currentVersion },
  });
}

function writeModelsJson(data: Record<string, unknown>, expectedVersion: string): string {
  const p = getModelsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const initial = readModelsFileSnapshot();
  if (initial.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, initial.version);
  // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
  const tmp = `${p}.${process.pid}.tmp`;
  const bak = `${p}.bak`;
  const serialized = JSON.stringify(data, null, 2);
  writeFileSync(tmp, serialized, "utf8");
  try {
    const beforeCommit = readModelsFileSnapshot();
    if (beforeCommit.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, beforeCommit.version);
    if (beforeCommit.raw !== null) {
      try {
        writeFileSync(bak, beforeCommit.raw, "utf8");
      } catch {
        /* ignore bak failure */
      }
    }
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  return modelsContentVersion(serialized);
}

async function resolveLoadedSkill(cwd: string, filePath: string) {
  if (!cwd || !filePath) {
    throw new RpcError({ code: "BAD_REQUEST", message: "cwd and filePath are required" });
  }
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const requested = realpathSync(filePath);
  const skill = loader.getSkills().skills.find((candidate) => {
    try {
      return realpathSync(candidate.filePath) === requested;
    } catch {
      return false;
    }
  });
  if (!skill) {
    throw new RpcError({ code: "FORBIDDEN", message: "Skill is not loaded for this project" });
  }
  return skill;
}

function writeTextAtomically(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: T[],
  enabledModels: string[] | undefined,
): T[] {
  if (!enabledModels || enabledModels.length === 0) return available;
  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter((m) => refs.has(`${m.provider}/${m.id}`) || refs.has(m.id));
  return visible.length > 0 ? visible : available;
}

function projectModelPreferences<T extends { id: string; name: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): ModelPreferencesResult {
  const models: ModelInfo[] = available
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const normalized = [...new Set((enabledModels ?? []).map(stripThinkingSuffix).filter(Boolean))];
  return { models, enabledModels: normalized.length > 0 ? normalized : null };
}

function normalizeEnabledModelsInput(value: unknown): string[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) {
    throw new RpcError({
      code: "BAD_REQUEST",
      message: "enabledModels must be null or a non-empty array with at most 2000 entries",
    });
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const valueEntry of value) {
    if (typeof valueEntry !== "string") {
      throw new RpcError({ code: "BAD_REQUEST", message: "Every enabled model reference must be a string" });
    }
    const modelReference = stripThinkingSuffix(valueEntry);
    if (!modelReference || modelReference.length > 512) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid enabled model reference" });
    }
    if (!seen.has(modelReference)) {
      seen.add(modelReference);
      normalized.push(modelReference);
    }
  }
  return normalized;
}

function hasMatchingEnabledModel<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[],
): boolean {
  const refs = new Set(enabledModels);
  return available.some((model) => refs.has(`${model.provider}/${model.id}`) || refs.has(model.id));
}

export async function credentialMutationFailure(
  modelRuntime: ModelRuntime,
  providerId: string,
  target: CredentialTarget,
  error: unknown,
) {
  if (error instanceof CredentialSynchronizationError) {
    const recovered = await recoverCommittedCredential(modelRuntime, providerId, target);
    if (recovered) {
      if (!recovered.synchronized) {
        console.warn(`[agent-host] credential ${error.operation} committed for ${providerId}; model sync retry failed`);
      }
      return recovered;
    }
    throw new RpcError({ code: "INTERNAL", message: `Credential change for ${providerId} could not be verified` });
  }
  throw new RpcError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
}

function resolveModelsCwd(params: { cwd?: string } | void): string {
  const cwd = params?.cwd || process.cwd();
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
  }
  return cwd;
}

type DirectoryValidation = { ok: true; path: string; canonicalPath: string } | { ok: false; error: string };

function validateExistingDirectory(candidate: unknown): DirectoryValidation {
  if (typeof candidate !== "string" || !candidate) return { ok: false, error: "Directory does not exist" };
  try {
    const realpath = realpathSync.native ?? realpathSync;
    const canonicalPath = realpath(candidate);
    if (!statSync(canonicalPath).isDirectory()) return { ok: false, error: "Not a directory" };
    return { ok: true, path: candidate, canonicalPath };
  } catch {
    return { ok: false, error: "Directory does not exist" };
  }
}

function canonicalPathForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  let canonical = resolved;
  try {
    const realpath = realpathSync.native ?? realpathSync;
    canonical = realpath(resolved);
  } catch {
    // Historical session cwd values can refer to directories that no longer exist.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

type AvailableModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

async function resolveAvailableModels(
  modelRuntime: ModelRuntime,
  signal?: AbortSignal,
): Promise<{ models: AvailableModel[]; warnings: ModelCatalogWarning[] }> {
  const snapshot = [...modelRuntime.getAvailableSnapshot()];
  const snapshotByProvider = new Map<string, AvailableModel[]>();
  for (const model of snapshot) {
    const models = snapshotByProvider.get(model.provider) ?? [];
    models.push(model);
    snapshotByProvider.set(model.provider, models);
  }

  const results = await Promise.all(
    [...modelRuntime.getProviders()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async (provider) => {
        try {
          const models = [...(await modelRuntime.getAvailable(provider.id, { signal }))];
          return { models, warning: undefined };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return {
            models: snapshotByProvider.get(provider.id) ?? [],
            warning: {
              provider: provider.id,
              code: "PROVIDER_AVAILABILITY_FAILED" as const,
              message: `Unable to check ${provider.id} model availability; the last known state remains available.`,
            },
          };
        }
      }),
  );
  signal?.throwIfAborted();
  return {
    models: results.flatMap((result) => result.models),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}

export async function projectModelsList(
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
  catalog: ModelCatalogStatus,
  options: { signal?: AbortSignal; cachedOnly?: boolean } = {},
): Promise<ModelsListResult> {
  const availability = options.cachedOnly
    ? { models: [...modelRuntime.getAvailableSnapshot()], warnings: [] }
    : await resolveAvailableModels(modelRuntime, options.signal);
  const available = availability.models;
  const enabledModels = settings.getEnabledModels();
  const visible = filterByExactEnabledModels(available, enabledModels);
  const models = visible
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

  const nameMap: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap[key] = model.name;
    thinkingLevels[key] = getSupportedThinkingLevels(model);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
  }

  let defaultModel: { provider: string; modelId: string } | null = null;
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider && modelId && visible.some((model) => model.provider === provider && model.id === modelId)) {
    defaultModel = { provider, modelId };
  }

  return {
    models,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    nameMap,
    catalog: availability.warnings.length
      ? { ...catalog, warnings: [...catalog.warnings, ...availability.warnings] }
      : catalog,
  };
}

export function initializeChannels(
  manager: Pick<ChannelManager, "initialize">,
  report: (message: string) => void = (message) => {
    try {
      process.parentPort?.postMessage({ type: "log", message: `[channels] initialization failed: ${message}` });
    } catch {
      /* ignore logging failure */
    }
  },
): void {
  void manager.initialize().catch((error) => report(safeChannelError(error)));
}

export function registerHandlers(server: RpcServer): () => Promise<void> {
  const fileWatch = createFileWatchService(server);
  const authLogin = createAuthLoginService(server);
  const channelManager = new ChannelManager(server, (session, sessionId) =>
    ensureSessionEvents(server, session, sessionId),
  );
  initializeChannels(channelManager);

  // Running sessions stream + tray badge signal to main via parentPort
  subscribeRunningSessions((ids) => {
    // Both fields remain in the current stream contract for renderer compatibility.
    server.emit("agent.running", "*", {
      type: "running",
      sessionIds: ids,
      runningSessionIds: ids,
    } as never);
    try {
      process.parentPort?.postMessage({ type: "running-sessions", sessionIds: ids });
    } catch {
      /* ignore */
    }
  });

  server.handle({
    "host.ping": () => ({ ok: true as const, ts: Date.now() }),

    "host.toolchain": async (params) => {
      const { cwd } = params as { cwd: string };
      if (!cwd || !path.isAbsolute(cwd)) throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
      const context = await toolchainRuntime.createExecutionContext({ cwd, intent: "project-command" });
      return {
        inventoryRevision: context.inventoryRevision,
        resolutionId: context.resolutionId,
        capabilities: Object.fromEntries(
          Object.entries(context.commands).map(([capability, command]) => [
            capability,
            { provider: command.provider, version: command.version },
          ]),
        ),
      };
    },

    "sessions.list": async (params) => {
      const traceId = resolveSessionTraceId();
      const startedAt = performance.now();
      try {
        const requestedCwd = (params as { cwd?: unknown } | undefined)?.cwd;
        if (requestedCwd !== undefined && (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd))) {
          throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
        }
        const canonicalCwd = typeof requestedCwd === "string" ? canonicalPathForComparison(requestedCwd) : undefined;
        const allSessions = await listAllSessions();
        const sessions = canonicalCwd
          ? allSessions.filter((session) => canonicalPathForComparison(session.cwd) === canonicalCwd)
          : allSessions;
        const indexMetrics = getSessionIndexMetrics();
        logSessionPerformance("sessions.list", {
          traceId,
          ok: true,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          sessionsReturned: sessions.length,
          filesDiscovered: indexMetrics.filesDiscovered,
          filesParsed: indexMetrics.filesParsed,
          filesReused: indexMetrics.filesReused,
          invalidFiles: indexMetrics.invalidFiles,
          indexRefreshMs: indexMetrics.totalMs,
        });
        return { sessions, runningSessionIds: getRunningRpcSessionIds() };
      } catch (error) {
        logSessionPerformance("sessions.list", {
          traceId,
          ok: false,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },

    "sessions.get": async (params) => {
      const {
        id,
        includeState,
        traceId: requestedTraceId,
        historyWindow,
      } = params as {
        id: string;
        includeState?: boolean;
        traceId?: string;
        historyWindow?: HistoryWindow;
      };
      const traceId = resolveSessionTraceId(requestedTraceId);
      const startedAt = performance.now();
      let stateMs = 0;
      try {
        const agentStatePromise: Promise<SessionDetail["agentState"]> = (async () => {
          if (!includeState) return undefined;
          const stateStartedAt = performance.now();
          const existing = getRpcSession(id);
          const result = existing?.isAlive()
            ? { running: true, state: (await existing.send({ type: "get_state" })) as SessionRuntimeState }
            : { running: false };
          stateMs = performance.now() - stateStartedAt;
          return result;
        })();

        const resolveStartedAt = performance.now();
        const filePath = await resolveSessionPath(id);
        const resolvePathMs = performance.now() - resolveStartedAt;
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });

        const openStartedAt = performance.now();
        const { manager: sm, entries } = getSessionContentSnapshot(filePath);
        const openMs = performance.now() - openStartedAt;

        const contextStartedAt = performance.now();
        const leafId = sm.getLeafId();
        const tree = projectSessionTreeForResponse(sm.getTree() as never) as SessionTreeNode[];
        const historyRevision = buildHistoryRevision(filePath, id);
        const context = buildSessionHistoryPage({ entries, leafId, historyWindow, historyRevision });
        const contextMs = performance.now() - contextStartedAt;

        const infoStartedAt = performance.now();
        const [info, agentState] = await Promise.all([
          buildSessionInfoFromManager(filePath, sm, entries),
          agentStatePromise,
        ]);
        const infoMs = performance.now() - infoStartedAt;

        const detail: SessionDetail = {
          sessionId: id,
          filePath,
          info,
          leafId,
          tree,
          context,
          ...(agentState !== undefined ? { agentState } : {}),
        };
        const responseBytes = sessionPerformanceBytesEnabled()
          ? Buffer.byteLength(JSON.stringify(detail), "utf8")
          : undefined;
        logSessionPerformance("sessions.get", {
          traceId,
          ok: true,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          resolvePathMs: roundSessionMilliseconds(resolvePathMs),
          openMs: roundSessionMilliseconds(openMs),
          contextMs: roundSessionMilliseconds(contextMs),
          infoMs: roundSessionMilliseconds(infoMs),
          stateMs: roundSessionMilliseconds(stateMs),
          entryCount: entries.length,
          messageCount: context.messages.length,
          fileBytes: statSync(filePath).size,
          ...(responseBytes === undefined ? {} : { responseBytes }),
        });
        return detail;
      } catch (error) {
        logSessionPerformance("sessions.get", {
          traceId,
          ok: false,
          totalMs: roundSessionMilliseconds(performance.now() - startedAt),
          error: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },

    "sessions.context": async (params) => {
      const { id, leafId, historyWindow } = params as { id: string; leafId?: string; historyWindow?: HistoryWindow };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      const context = buildSessionHistoryPage({
        entries,
        leafId,
        historyWindow,
        historyRevision: buildHistoryRevision(filePath, id),
      });
      return { context };
    },

    "sessions.contextPage": async (params) => {
      const { id, cursor, maxTurns, maxBytes } = params as {
        id: string;
        cursor: string;
        maxTurns?: number;
        maxBytes?: number;
      };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      try {
        const context = buildSessionHistoryPage({
          entries,
          historyWindow: { maxTurns, maxBytes },
          historyRevision: buildHistoryRevision(filePath, id),
          cursor: decodeHistoryCursor(cursor),
        });
        return { context };
      } catch (error) {
        if (error instanceof StaleHistoryCursorError) {
          throw new RpcError({ code: "STALE_CURSOR", message: error.message });
        }
        if (error instanceof Error && error.message === "Invalid session history cursor") {
          throw new RpcError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    },

    "sessions.entryContent": async (params) => {
      const { id, entryId, blockIndex = 0 } = params as { id: string; entryId: string; blockIndex?: number };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const { entries } = getSessionContentSnapshot(filePath);
      const content = readSessionEntryContent(entries, entryId, blockIndex);
      if (content === null) {
        throw new RpcError({ code: "NOT_FOUND", message: "Session entry content not found" });
      }
      return {
        content,
        deferredContent: {
          entryId,
          blockIndex,
          originalBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
          contentType: content.type,
        },
      };
    },

    "sessions.export": async (params) => {
      const { id, format = "md" } = params as { id: string; format?: "md" | "json" };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const raw = readFileSync(filePath, "utf8");
      if (format === "json") {
        return { content: raw, suggestedName: `session-${id}.json` };
      }
      // Simple markdown export of session file content
      const sm = SessionManager.open(filePath);
      const context = buildSessionContext(sm.getEntries() as never);
      const lines: string[] = [`# Session ${id}`, ""];
      for (const msg of context.messages as Array<{ role: string; content: unknown }>) {
        lines.push(`## ${msg.role}`, "");
        if (typeof msg.content === "string") lines.push(msg.content);
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type?: string; text?: string }>) {
            if (block.type === "text" && block.text) lines.push(block.text);
          }
        }
        lines.push("");
      }
      return { content: lines.join("\n"), suggestedName: `session-${id}.md` };
    },

    "sessions.delete": async (params) => {
      const { id, force } = params as { id: string; force?: boolean };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        if (existing.isRunning() && !force) {
          throw new RpcError({
            code: "CONFLICT",
            message: "Session is still running. Stop it before deleting.",
          });
        }
        // ISSUE-001: fully stop agent before unlinking session file
        await existing.abortAndDispose();
        clearSessionEventBinding(existing.sessionId || id);
      }
      try {
        unlinkSync(filePath);
      } catch (e) {
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      invalidateSessionContent(filePath);
      const deletedSession = sessionIndex.removePath(filePath);
      invalidateSessionPathCache(id);
      void callMain("browser.sessionEnded", { sessionId: id }).catch(() => undefined);
      server.emit("sessions.changed", id, {
        cwd: deletedSession?.cwd ?? null,
        sessionId: id,
        deleted: true,
      });
      return { ok: true as const };
    },

    "sessions.rename": async (params) => {
      const { id, name } = params as { id: string; name: string };
      if (!name?.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "name is required" });
      }
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        await existing.send({ type: "set_session_name", name: name.trim() });
      } else {
        const filePath = await resolveSessionPath(id);
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
        const sm = SessionManager.open(filePath);
        // ISSUE-014: SDK uses appendSessionInfo, not setSessionName
        sm.appendSessionInfo(name.trim());
        invalidateSessionContent(filePath);
      }
      await emitIndexedSessionChange(server, id, null);
      return { ok: true as const };
    },

    "sessions.setArchived": async (params) => {
      const { id, archived } = params as { id: string; archived: boolean };
      if (typeof archived !== "boolean") {
        throw new RpcError({ code: "BAD_REQUEST", message: "archived is required" });
      }
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        forkAppendArchived(existing.inner.sessionManager, archived);
      } else {
        const filePath = await resolveSessionPath(id);
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
        forkAppendArchived(SessionManager.open(filePath), archived);
        invalidateSessionContent(filePath);
      }
      await emitIndexedSessionChange(server, id, null);
      return { ok: true as const };
    },

    "sessions.relocate": async (params) => {
      const { id, cwd } = params as { id: string; cwd: string };
      const validation = validateExistingDirectory(cwd);
      if (!validation.ok) {
        throw new RpcError({ code: "BAD_REQUEST", message: validation.error });
      }
      const toCwd = validation.canonicalPath;
      allowFileRoot(toCwd);

      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        if (existing.isRunning()) {
          throw new RpcError({
            code: "CONFLICT",
            message: "Session is still running. Stop it before changing the working directory.",
          });
        }
        await existing.abortAndDispose();
        clearSessionEventBinding(existing.sessionId || id);
      }

      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const current = sessionIndex.getByPath(filePath) ?? (await sessionIndex.refreshPath(filePath));
      const fromCwd = current?.cwd ?? SessionManager.open(filePath).getCwd();
      if (canonicalPathForComparison(fromCwd) === canonicalPathForComparison(toCwd)) {
        if (current) return { session: current };
        const session = await sessionIndex.refreshPath(filePath);
        if (!session) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
        return { session };
      }

      let destPath: string;
      try {
        destPath = relocateSessionFile(filePath, fromCwd, toCwd);
      } catch (e) {
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }

      invalidateSessionContent(filePath);
      invalidateSessionContent(destPath);
      sessionIndex.removePath(filePath);
      invalidateSessionPathCache(id);
      cacheSessionPath(id, destPath);
      const session = await sessionIndex.refreshPath(destPath);
      if (!session) throw new RpcError({ code: "INTERNAL", message: "Session index missed relocated file" });
      server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
      return { session };
    },

    "worktrees.list": async (params) => {
      const { projectRoot } = params as { projectRoot: string };
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(projectRoot, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const project = await resolveProject(projectRoot);
      let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
      let isGit = true;
      try {
        worktrees = await listWorktrees(existsSync(projectRoot) ? projectRoot : project.projectRoot);
      } catch {
        isGit = false;
      }
      for (const w of worktrees) allowFileRoot(w.path);
      return {
        worktrees,
        projectRoot: project.projectRoot,
        isGit,
        isTopLevel: project.isTopLevel,
      };
    },

    "worktrees.create": async (params) => {
      const body = params as { projectRoot: string; branch: string; cwd?: string };
      const cwd = body.cwd ?? body.projectRoot;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const result = await addWorktree(cwd, body.branch);
      allowFileRoot(result.path);
      return { worktree: result };
    },

    "worktrees.remove": async (params) => {
      const body = params as { path: string; cwd?: string; force?: boolean };
      const cwd = body.cwd ?? body.path;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      try {
        await removeWorktree(cwd, body.path, body.force === true);
      } catch (error) {
        if (!body.force && isDirtyWorktreeError(error)) {
          throw new RpcError({
            code: "CONFLICT",
            message: error instanceof Error ? error.message : String(error),
            detail: { dirty: true },
          });
        }
        throw error;
      }
      return { ok: true as const };
    },

    "git.status": async (params) => {
      const { path: cwd } = params as { path: string };
      await assertPathAllowed(cwd);
      return getGitStatus(cwd);
    },

    "agent.new": async (params) => {
      const body = params as {
        cwd: string;
        type?: string;
        message?: string;
        provider?: string;
        modelId?: string;
        toolNames?: string[];
        thinkingLevel?: string;
        [key: string]: unknown;
      };
      const { cwd, provider, modelId, toolNames, thinkingLevel, ...rest } = body;
      if (!cwd || typeof cwd !== "string") {
        throw new RpcError({ code: "BAD_REQUEST", message: "cwd is required" });
      }
      if (!existsSync(cwd)) {
        throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
      }

      const tempKey = createAgentNewLockKey();
      const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames);
      allowFileRoot(cwd);

      // ISSUE-003: single event-binding entry only (ensureSessionEvents)
      ensureSessionEvents(server, session, realSessionId);

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (rest.type === "ensure_session") {
        return { sessionId: realSessionId, data: null };
      }

      const command = rest.type ? rest : { type: "prompt", message: body.message ?? "" };
      const data = await session.send(command as Record<string, unknown>);
      await emitIndexedSessionChange(server, realSessionId, cwd);
      return { sessionId: realSessionId, data };
    },

    "agent.command": async (params) => {
      const { sessionId, command } = params as {
        sessionId: string;
        command: Record<string, unknown>;
      };
      const existing = getRpcSession(sessionId);
      if (existing?.isAlive()) {
        // Ensure event subscription
        ensureSessionEvents(server, existing, sessionId);
        return existing.send(command);
      }
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      const { session } = await startRpcSession(sessionId, filePath, cwd);
      ensureSessionEvents(server, session, sessionId);
      return session.send(command);
    },

    "agent.state": async (params) => {
      const { sessionId } = params as { sessionId: string };
      const session = getRpcSession(sessionId);
      if (!session || !session.isAlive()) return { running: false };
      const state = await session.send({ type: "get_state" });
      return { running: true, state };
    },

    "channels.list": async () => channelManager.snapshot(),

    "channels.accountUpsert": async (params) => channelManager.upsertAccount(params.account),

    "channels.accountConnect": async (params) => channelManager.connectAccount(params.account),

    "channels.accountDelete": async (params) => channelManager.deleteAccount(params.accountId),

    "channels.start": async (params) => {
      await channelManager.startAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.stop": async (params) => {
      await channelManager.stopAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.restart": async (params) => {
      await channelManager.restartAccount(params.accountId);
      return { ok: true as const };
    },

    "channels.probe": async (params) => channelManager.probe(params.accountId),

    "channels.loginStart": async (params) => channelManager.startLogin(params),

    "channels.loginWait": async (params) => channelManager.waitLogin(params.channel, params.sessionKey),

    "channels.loginSubmitCode": async (params) => {
      channelManager.submitLoginCode(params.channel, params.sessionKey, params.code);
      return { ok: true as const };
    },

    "channels.loginCancel": async (params) => {
      channelManager.cancelLogin(params.channel, params.sessionKey);
      return { ok: true as const };
    },

    "channels.pairingApprove": async (params) => channelManager.approvePairing(params.pairingId),

    "channels.pairingReject": async (params) => channelManager.rejectPairing(params.pairingId),

    "channels.bindingUpsert": async (params) => channelManager.upsertBinding(params.binding),

    "channels.bindingDelete": async (params) => channelManager.deleteBinding(params.bindingId),

    "channels.testSend": async (params) => channelManager.testSend(params.accountId, params.peerId, params.message),

    "files.list": async (params) => {
      const { path: dirPath } = params as { path: string };
      await assertPathAllowed(dirPath);
      if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
        throw new RpcError({ code: "NOT_FOUND", message: "Directory not found" });
      }
      const names = readdirSync(dirPath);
      const entries: Array<{
        name: string;
        isDir: boolean;
        size?: number;
        mtime?: number;
        path: string;
        type: "file" | "directory";
      }> = [];
      for (const name of names) {
        if (IGNORED_NAMES.has(name)) continue;
        const full = path.join(dirPath, name);
        try {
          const st = statSync(full);
          const isDir = st.isDirectory();
          entries.push({
            name,
            path: full,
            isDir,
            type: isDir ? "directory" : "file",
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {
          /* skip unreadable */
        }
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { entries: entries as never };
    },

    "files.read": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }

      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      const binaryMime = imageMime || audioMime || documentMime;

      // ISSUE-004: binary as base64+mime; never UTF-8 corrupt
      if (binaryMime) {
        const limit = imageMime ? IMAGE_PREVIEW_MAX_BYTES : documentMime ? DOCX_PREVIEW_MAX_BYTES : 50 * 1024 * 1024;
        if (st.size > limit) {
          return {
            content: "",
            encoding: "too_large" as const,
            mime: binaryMime,
            language: getLanguage(filePath),
            size: st.size,
            truncated: true,
          };
        }
        return {
          content: readFileSync(filePath).toString("base64"),
          encoding: "base64" as const,
          mime: binaryMime,
          language: getLanguage(filePath),
          size: st.size,
          truncated: false,
        };
      }

      // Text: only read up to limit
      const fd = await import("fs").then((fs) => fs.openSync(filePath, "r"));
      try {
        const max = Math.min(st.size, TEXT_PREVIEW_MAX_BYTES);
        const buf = Buffer.alloc(max);
        const n = (await import("fs")).readSync(fd, buf, 0, max, 0);
        return {
          content: buf.slice(0, n).toString("utf8"),
          encoding: "utf8" as const,
          language: getLanguage(filePath),
          size: st.size,
          truncated: st.size > TEXT_PREVIEW_MAX_BYTES,
        };
      } finally {
        (await import("fs")).closeSync(fd);
      }
    },

    "files.download": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }
      if (st.size > FILE_DOWNLOAD_MAX_BYTES) {
        throw new RpcError({
          code: "RESULT_TOO_LARGE",
          message: `File exceeds the ${FILE_DOWNLOAD_MAX_BYTES / 1024 / 1024} MiB download limit`,
          detail: { size: st.size, maxBytes: FILE_DOWNLOAD_MAX_BYTES },
        });
      }
      return {
        base64: readFileSync(filePath).toString("base64"),
        size: st.size,
        mime:
          getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream",
      };
    },

    "files.meta": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return {
        size: st.size,
        mtime: st.mtimeMs,
        language: getLanguage(filePath),
        kind: documentPreviewKind(filePath) ?? (imageMime ? "image" : "file"),
        mime: imageMime ?? audioMime ?? documentMime ?? "text/plain",
      };
    },

    "files.preview": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      const imgMime = getImageMime(filePath);
      if (imgMime) {
        if (st.size > IMAGE_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: imgMime, size: st.size };
        }
        return {
          kind: "image",
          mime: imgMime,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      const docKind = documentPreviewKind(filePath);
      if (docKind === "docx") {
        if (st.size > DOCX_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: getDocumentMime(filePath) ?? undefined, size: st.size };
        }
        return {
          kind: "docx",
          mime: getDocumentMime(filePath) ?? undefined,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      if (st.size > TEXT_PREVIEW_MAX_BYTES) {
        return {
          kind: "text",
          content: readFileSync(filePath, "utf8").slice(0, TEXT_PREVIEW_MAX_BYTES),
          language: getLanguage(filePath),
          truncated: true,
        };
      }
      return {
        kind: "text",
        content: readFileSync(filePath, "utf8"),
        language: getLanguage(filePath),
      };
    },

    "files.index": async (params) => {
      // ISSUE-005: return relative POSIX paths + { files, truncated, matches }
      const { root, query } = params as { root: string; query?: string };
      await assertPathAllowed(root);
      let relFiles: string[] = [];
      let truncatedReason: "depth" | "count" | undefined;

      try {
        const all = await listGitFiles(root);
        if (all.length > 50_000) {
          truncatedReason = "count";
          relFiles = all.slice(0, 50_000);
        } else {
          relFiles = all;
        }
      } catch {
        const abs: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 8) {
            truncatedReason ??= "depth";
            return;
          }
          if (abs.length >= 5000) {
            truncatedReason = "count";
            return;
          }
          let names: string[];
          try {
            names = readdirSync(dir);
          } catch {
            return;
          }
          for (const name of names) {
            if (IGNORED_NAMES.has(name) || name.startsWith(".")) continue;
            const full = path.join(dir, name);
            try {
              const st = statSync(full);
              if (st.isDirectory()) walk(full, depth + 1);
              else abs.push(full);
            } catch {
              /* skip */
            }
            if (abs.length >= 5000) {
              truncatedReason = "count";
              return;
            }
          }
        };
        walk(root, 0);
        const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
        relFiles = abs.map((f) => {
          const n = f.replace(/\\/g, "/");
          return n.startsWith(rootNorm + "/") ? n.slice(rootNorm.length + 1) : n;
        });
      }

      const CLIENT_CAP = 5000;
      const filesForClient = relFiles.slice(0, CLIENT_CAP);
      if (relFiles.length > CLIENT_CAP) truncatedReason = "count";
      const truncated = truncatedReason !== undefined;
      const entries = buildEntriesFromFiles(filesForClient);

      if (query?.trim()) {
        const matches = filterFileEntries(entries, query.trim()).slice(0, 50);
        return {
          files: filesForClient,
          truncated,
          ...(truncatedReason ? { truncatedReason } : {}),
          matches: matches.map((m) => ({
            path: m.path,
            isDir: m.isDir,
            score: "score" in m ? Number((m as { score?: number }).score ?? 0) : 0,
          })),
        };
      }

      return {
        files: filesForClient,
        truncated,
        ...(truncatedReason ? { truncatedReason } : {}),
        matches: entries.slice(0, 100).map((m) => ({
          path: m.path,
          isDir: m.isDir,
          score: 0,
        })),
      };
    },

    "models.list": async (params) => {
      const cwd = resolveModelsCwd(params as { cwd?: string } | void);
      const agentDir = getAgentDir();
      const services = await createAgentSessionServices({ cwd, agentDir });
      return projectModelsList(services.modelRuntime, services.settingsManager, {
        source: process.env.PI_OFFLINE === undefined ? "cache" : "offline",
        refreshed: false,
        aborted: false,
        warnings: [],
      });
    },

    "models.refresh": async (params) => {
      const { requestId } = params as { cwd?: string; requestId: string };
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid model refresh request id" });
      }
      const cwd = resolveModelsCwd(params);
      const agentDir = getAgentDir();
      return modelCatalogRefreshCoordinator.refresh(
        cwd,
        requestId,
        (signal) => createAgentSessionServices({ cwd, agentDir, modelRuntimeSignal: signal }),
        ({ services, catalog }, signal) =>
          projectModelsList(services.modelRuntime, services.settingsManager, catalog, {
            signal,
            cachedOnly: catalog.aborted,
          }),
      );
    },

    "models.refreshCancel": (params) => {
      const { requestId } = params as { requestId: string };
      return { ok: true as const, cancelled: modelCatalogRefreshCoordinator.cancel(requestId) };
    },

    "models.preferences.get": async (params) => {
      const cwd = resolveModelsCwd(params as { cwd?: string } | void);
      const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
      const { models: available } = await resolveAvailableModels(services.modelRuntime);
      return projectModelPreferences(available, services.settingsManager.getEnabledModels());
    },

    "models.preferences.set": async (params) => {
      const body = params as { cwd?: string; enabledModels?: unknown };
      const cwd = resolveModelsCwd(body);
      const enabledModels = normalizeEnabledModelsInput(body.enabledModels);
      const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
      const { models: available } = await resolveAvailableModels(services.modelRuntime);
      if (enabledModels && !hasMatchingEnabledModel(available, enabledModels)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "At least one available model must remain enabled" });
      }
      services.settingsManager.setEnabledModels(enabledModels);
      return projectModelPreferences(available, enabledModels);
    },

    "modelsConfig.get": () => readModelsJsonSnapshot(),
    "modelsConfig.set": async (params) => {
      const body = params as { config?: unknown; expectedVersion?: unknown };
      const config = body?.config as Record<string, unknown> | undefined;
      // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
      if (!config || typeof config !== "object" || !("providers" in config)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
      }
      if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
        throw new RpcError({ code: "BAD_REQUEST", message: "expectedVersion is required" });
      }
      const version = writeModelsJson(config, body.expectedVersion);
      await reloadSharedModelRuntimeConfig();
      return { ok: true as const, version };
    },
    "modelsConfig.test": async (params) => {
      const body = params as unknown as {
        providerName?: string;
        provider?: Record<string, unknown>;
        model?: Record<string, unknown>;
      };
      const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
      if (!providerName) return { ok: false, error: "providerName is required" };
      if (!body.provider || typeof body.provider !== "object") {
        return { ok: false, error: "provider is required" };
      }
      if (!body.model || typeof body.model !== "object") {
        return { ok: false, error: "model is required" };
      }
      const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
      if (!modelId) return { ok: false, error: "Model ID is required" };

      let tempDir: string | undefined;
      try {
        tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-test-"));
        const modelsPath = path.join(tempDir, "models.json");
        writeFileSync(
          modelsPath,
          JSON.stringify(
            {
              providers: {
                [providerName]: {
                  ...body.provider,
                  models: [{ ...body.model, id: modelId }],
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
        const loadError = modelRuntime.getError();
        if (loadError) return { ok: false, error: loadError };

        const model = modelRuntime.getModel(providerName, modelId);
        if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

        const auth = await modelRuntime.getAuth(model);
        if (!auth) return { ok: false, error: `No authentication found for "${providerName}"` };

        const TEST_TIMEOUT_MS = 20_000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        let status: number | undefined;
        const startedAt = Date.now();
        try {
          const message = await modelRuntime.completeSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: "Reply with OK only.",
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens: 16,
              timeoutMs: TEST_TIMEOUT_MS,
              maxRetries: 0,
              cacheRetention: "none",
              signal: controller.signal,
              onResponse: (response: { status: number }) => {
                status = response.status;
              },
            },
          );

          const latencyMs = Date.now() - startedAt;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            return {
              ok: false,
              error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
              latencyMs,
              status,
            };
          }
          const responseText = message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("")
            .slice(0, 300);
          return { ok: true, latencyMs, status, responseText };
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (tempDir) {
          try {
            rmSync(tempDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },

    "auth.providers": async () => {
      const modelRuntime = await getSharedModelRuntime();
      const storedProviders = new Set(
        (await modelRuntime.listCredentials())
          .filter((entry) => entry.type === "oauth")
          .map((entry) => entry.providerId),
      );
      const EXCLUDED = new Set(["anthropic"]);
      const DISPLAY_NAMES: Record<string, string> = {
        "openai-codex": "ChatGPT Plus/Pro",
        "github-copilot": "GitHub Copilot",
      };
      const result = modelRuntime
        .getProviders()
        .filter((p) => p.auth.oauth && !EXCLUDED.has(p.id))
        .map((p) => ({
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: false,
          authenticated: storedProviders.has(p.id),
          loggedIn: storedProviders.has(p.id),
        }));
      return { providers: result };
    },

    "auth.allProviders": async () => {
      const modelRuntime = await getSharedModelRuntime();
      const all = modelRuntime.getModels();
      const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);
      const seen = new Set<string>();
      const result: Array<{
        id: string;
        displayName: string;
        configured: boolean;
        source?: string;
        modelCount: number;
      }> = [];
      for (const model of all) {
        if (seen.has(model.provider)) continue;
        seen.add(model.provider);
        if (OAUTH_PROVIDER_IDS.has(model.provider)) continue;
        const provider = modelRuntime.getProvider(model.provider);
        if (!provider?.auth.apiKey) continue;
        const status = modelRuntime.getProviderAuthStatus(model.provider);
        if (status.source === "models_json_key") continue;
        result.push({
          id: model.provider,
          displayName: provider.name,
          configured: status.configured,
          source: status.label ?? status.source,
          modelCount: all.filter((candidate) => candidate.provider === model.provider).length,
        });
      }
      return { providers: result as never };
    },

    "auth.setApiKey": async (params) => {
      const { provider, key } = params as { provider: string; key: string };
      if (!provider || !key?.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "provider and key required" });
      }
      const modelRuntime = await getSharedModelRuntime();
      let promptCount = 0;
      const interaction: AuthInteraction = {
        async prompt(request) {
          promptCount += 1;
          if (promptCount !== 1 || request.type !== "secret") {
            throw new Error(`${provider} requires an interactive, multi-field login flow`);
          }
          return key.trim();
        },
        notify() {},
      };
      try {
        await modelRuntime.login(provider, "api_key", interaction);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: true, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: true, type: "api_key" }))) {
        throw new RpcError({
          code: "INTERNAL",
          message: `Key for ${provider} was written but not readable back`,
        });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.deleteApiKey": async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false, type: "api_key" }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false, type: "api_key" }))) {
        throw new RpcError({ code: "INTERNAL", message: `Key removal for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.logout": async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      try {
        await modelRuntime.logout(provider);
      } catch (error) {
        return credentialMutationFailure(modelRuntime, provider, { present: false }, error);
      }
      if (!(await credentialStateMatches(modelRuntime, provider, { present: false }))) {
        throw new RpcError({ code: "INTERNAL", message: `Logout for ${provider} could not be verified` });
      }
      return { ok: true as const, synchronized: true };
    },

    "auth.loginSubmit": async (params) => {
      const { provider, token, code } = params as {
        provider: string;
        token: string;
        code: string;
      };
      if (!resolveLoginCode(provider, token, code)) {
        throw new RpcError({ code: "NOT_FOUND", message: "No pending login for token" });
      }
      return { ok: true as const };
    },

    "auth.loginStart": async (params) => {
      const { provider } = params as { provider: string };
      const result = await authLogin.start(provider);
      return { ok: true as const, started: result.started };
    },

    "auth.loginCancel": async (params) => {
      const { provider } = params as { provider: string };
      authLogin.cancel(provider);
      return { ok: true as const };
    },

    "skills.list": async (params) => {
      const cwd = (params as { cwd?: string } | void)?.cwd;
      if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      return { skills, diagnostics };
    },

    "skills.search": async (params) => {
      const { query } = params as { query: string };
      try {
        return (await searchSkills(query)) as never;
      } catch (e) {
        if (e instanceof ToolchainError) throw e;
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    "skills.install": async (params) => {
      try {
        return await installSkill(params as { package: string; scope?: "global" | "project"; cwd?: string });
      } catch (e) {
        if (e instanceof ToolchainError) throw e;
        throw new RpcError({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    "skills.set": async (params) => {
      const body = params as {
        cwd: string;
        filePath: string;
        disableModelInvocation?: boolean;
        content?: string;
      };
      const skill = await resolveLoadedSkill(body.cwd, body.filePath);
      const { filePath } = skill;
      const content = body.content ?? readFileSync(filePath, "utf8");
      if (content.length > 2 * 1024 * 1024) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Skill file is too large" });
      }
      const updated =
        body.disableModelInvocation === undefined
          ? content
          : updateSkillModelInvocation(content, body.disableModelInvocation);
      writeTextAtomically(filePath, updated);
      return { ok: true as const };
    },

    "skills.getContent": async (params) => {
      const body = params as { cwd: string; filePath: string };
      const skill = await resolveLoadedSkill(body.cwd, body.filePath);
      return { content: readFileSync(skill.filePath, "utf8") };
    },

    "plugins.list": async (params) => {
      const cwd = (params as { cwd?: string } | void)?.cwd;
      if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
      return readPlugins(cwd);
    },

    "plugins.set": async (params) => {
      return applyPluginAction(params);
    },

    "files.watchStart": async (params, context) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      const leaseKey = `files.watch:${filePath}`;
      context?.releaseLease(leaseKey);
      const release = await fileWatch.start(filePath, sourceSessionId);
      context?.setLease(leaseKey, release);
      return { ok: true as const };
    },

    "files.watchStop": async (params, context) => {
      const { path: filePath } = params as { path: string };
      if (context) context.releaseLease(`files.watch:${filePath}`);
      else fileWatch.stop(filePath);
      return { ok: true as const };
    },

    "system.home": () => ({ home: homedir() }),

    "system.validateCwd": async (params) => {
      const { path: dir } = params as { path: string };
      const validation = validateExistingDirectory(dir);
      if (!validation.ok) return validation;
      allowFileRoot(validation.canonicalPath);
      return { ok: true as const, path: validation.path };
    },

    "system.defaultCwd": async () => {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const dir = path.join(homedir(), `pi-cwd-${date}`);
      mkdirSync(dir, { recursive: true });
      allowFileRoot(dir);
      return { cwd: dir };
    },

    "system.allowRoot": async (params) => {
      const { path: dir } = params as { path: string };
      const validation = validateExistingDirectory(dir);
      if (!validation.ok) throw new RpcError({ code: "BAD_REQUEST", message: validation.error });
      allowFileRoot(validation.canonicalPath);
      return { ok: true as const };
    },

    "system.runningCount": async () => {
      const sessionIds = getRunningRpcSessionIds();
      return { count: sessionIds.length, sessionIds };
    },
  });

  return async () => {
    modelCatalogRefreshCoordinator.cancelAll();
    await channelManager.shutdown();
    stopAllFileWatches();
    await disposeAllRpcSessions();
  };
}

export function createAgentNewLockKey(): string {
  return `__new__${randomUUID()}`;
}

/** ISSUE-003: track bindings per wrapper instance, not permanent sessionId set */
const eventBoundWrappers = new WeakSet<object>();
const eventUnsubsBySession = new Map<string, () => void>();

function clearSessionEventBinding(sessionId: string): void {
  const unsub = eventUnsubsBySession.get(sessionId);
  if (unsub) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
    eventUnsubsBySession.delete(sessionId);
  }
}

function ensureSessionEvents(
  server: RpcServer,
  session: {
    sessionId: string;
    onEvent: (l: (e: { type: string; [k: string]: unknown }) => void) => () => void;
    onDestroy?: (cb: () => void) => void | (() => void);
  },
  sessionId: string,
): void {
  if (eventBoundWrappers.has(session as object)) return;
  eventBoundWrappers.add(session as object);

  const key = session.sessionId || sessionId;
  // Replace any stale binding for this session id (re-opened after idle destroy)
  clearSessionEventBinding(key);

  const unsub = session.onEvent((event) => {
    server.emit("agent.events", key, event as never);
    // ISSUE-015: only agent_end (not synthetic prompt_done) for system notifications
    if (event.type === "agent_end") {
      try {
        process.parentPort?.postMessage({
          type: "agent-end",
          sessionId: key,
          eventType: event.type,
        });
      } catch {
        /* ignore */
      }
    }
  });
  eventUnsubsBySession.set(key, unsub);
  session.onDestroy?.(() => {
    clearSessionEventBinding(key);
  });
}
