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
import { execSync } from "child_process";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { homedir, tmpdir } from "os";
import path from "path";
import {
  DefaultResourceLoader,
  CredentialSynchronizationError,
  ModelRuntime,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
  parseFrontmatter,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import type { RpcServer } from "../contract/rpc";
import {
  RpcError,
  type BuiltinModelInfo,
  type HistoryWindow,
  type ModelInfo,
  type ModelCatalogStatus,
  type ModelPreferencesResult,
  type ModelsListResult,
  type SessionDetail,
  type SessionRuntimeState,
} from "../contract/types";
import type { SessionTreeNode } from "../shared/types";
import { allowFileRoot, getAllowedFileRoots, invalidateAllowedRootsCache, isFilePathAllowed } from "./file-access";
import { getRpcSession, getRunningRpcSessionIds, startRpcSession, subscribeRunningSessions } from "./rpc-manager";
import {
  buildSessionContext,
  buildSessionInfoFromManager,
  getSessionIndexMetrics,
  invalidateSessionPathCache,
  listAllSessions,
  resolveSessionPath,
} from "./session-reader";
import { isFilePathReferencedBySession } from "./session-file-references";
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
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getImageMime,
} from "../shared/file-types";
import { createFileWatchService } from "./file-watch";
import { callMain } from "./parent-rpc";
import { createAuthLoginService, resolveLoginCode } from "./auth-login";
import { getSharedModelRuntime, modelCatalogRefreshCoordinator, reloadSharedModelRuntimeConfig } from "./model-runtime";
import { applyPluginAction, readPlugins } from "./plugins-service";
import { installSkill, searchSkills } from "./skills-service";
import { projectSessionTreeForResponse } from "./project-tree";
import { ChannelManager } from "./channels/channel-manager";
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

function readModelsJson(): Record<string, unknown> {
  const p = getModelsPath();
  if (!existsSync(p)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: `Failed to parse models.json: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const p = getModelsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
  const tmp = `${p}.${process.pid}.tmp`;
  const bak = `${p}.bak`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    if (existsSync(p)) {
      try {
        writeFileSync(bak, readFileSync(p));
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
}

// ── Built-in provider overlays (custom Base URL + enabled models) ────────────

function getBuiltinProviderDefaults(): Map<
  string,
  { id: string; name: string; baseUrl: string; api: string; getModels: () => { id: string; name: string }[] }
> {
  const result = new Map<
    string,
    { id: string; name: string; baseUrl: string; api: string; getModels: () => { id: string; name: string }[] }
  >();
  for (const provider of builtinProviderCatalog.builtinProviders()) {
    const models = provider.getModels();
    result.set(provider.id, {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      api: models[0]?.api ?? "",
      getModels: () => models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    });
  }
  return result;
}

function getProviderOverlay(
  config: Record<string, unknown>,
  providerId: string,
  defaultBaseUrl: string,
): {
  customBaseUrl?: string;
  enabledModels?: string[];
} {
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const entry = providers[providerId] ?? {};
  const rawBaseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  // A Base URL identical to the official endpoint is not a customization.
  const customBaseUrl = rawBaseUrl && rawBaseUrl !== defaultBaseUrl ? rawBaseUrl : undefined;
  const enabledModels = Array.isArray(entry.enabledModels)
    ? entry.enabledModels.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : undefined;
  return { customBaseUrl, enabledModels };
}

/**
 * Resolve a models.json-style config value (literal, `$ENV_VAR` / `${ENV_VAR}`,
 * or `!shell-command`) to a concrete string for outbound model-list requests.
 */
function resolveConfigValueSafely(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("!")) {
    try {
      const out = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000 });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name: string | undefined = braced ?? bare;
    return name && process.env[name] !== undefined ? (process.env[name] as string) : match;
  });
}

function parseModelsResponse(data: unknown): BuiltinModelInfo[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  let list: unknown = record.data;
  if (!Array.isArray(list)) list = record.models;
  if (Array.isArray(list)) {
    const out: BuiltinModelInfo[] = [];
    for (const item of list) {
      if (typeof item === "string") {
        if (item.trim()) out.push({ id: item.trim(), name: item.trim() });
      } else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const rawId =
          typeof entry.id === "string"
            ? entry.id
            : typeof entry.model === "string"
              ? entry.model
              : typeof entry.name === "string"
                ? entry.name
                : undefined;
        if (rawId && rawId.trim()) {
          const trimmed = rawId.trim();
          // Google lists models as "models/<id>" with a separate display name.
          const id = trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
          const name =
            typeof entry.displayName === "string" && entry.displayName.trim()
              ? entry.displayName.trim()
              : typeof entry.name === "string" && entry.name.trim() && entry.name.trim() !== trimmed
                ? entry.name.trim()
                : id;
          out.push({ id, name });
        }
      }
    }
    return out;
  }
  // Object keyed by model id (some gateways / proxies return this shape).
  const out: BuiltinModelInfo[] = [];
  for (const [id, value] of Object.entries(record)) {
    if (!id.trim()) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name;
      out.push({ id: id.trim(), name: typeof name === "string" ? name : id.trim() });
    }
  }
  return out;
}

function extractApiErrorBody(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (parsed.error && typeof parsed.error === "object") {
      const msg = (parsed.error as Record<string, unknown>).message;
      if (typeof msg === "string" && msg) return msg;
    }
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    return text.slice(0, 300);
  }
  return undefined;
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

/**
 * Exact model allowlist from settings (`enabledModels`), applied to the model
 * picker. Refs are bare model ids or `provider/model` pairs.
 *
 * The provider portion matches case-insensitively, so renaming a custom
 * provider's identifier (e.g. "VectorEngine" → "vector-engine") does not orphan
 * its models out of the picker. Refs naming a provider that no longer exists
 * are treated as stale and kept alive by bare model id instead, so a rename or
 * removal cannot silently hide that provider's models while other allowlisted
 * models keep the fallback from triggering.
 */
export function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: T[],
  enabledModels: string[] | undefined,
): T[] {
  if (!enabledModels || enabledModels.length === 0) return available;
  const providers = new Set(available.map((m) => m.provider.toLowerCase()));
  const refs = new Set<string>();
  for (const raw of enabledModels) {
    const ref = stripThinkingSuffix(raw);
    if (!ref) continue;
    const slash = ref.lastIndexOf("/");
    if (slash === -1) {
      refs.add(ref);
      continue;
    }
    const refProvider = ref.slice(0, slash);
    const refModel = ref.slice(slash + 1);
    if (providers.has(refProvider.toLowerCase())) {
      refs.add(`${refProvider.toLowerCase()}/${refModel}`);
    } else {
      // Provider no longer exists (renamed or removed): keep the model enabled
      // by bare id so a stale identifier cannot hide it.
      refs.add(refModel);
    }
  }
  const visible = available.filter((m) => refs.has(m.id) || refs.has(`${m.provider.toLowerCase()}/${m.id}`));
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

/**
 * Per-provider enabled model ids persisted in models.json (`providers.<id>.enabledModels`).
 * Unlike the global settings allowlist this filter is authoritative: disabling every
 * model of a provider removes that provider from the chat model picker.
 */
function filterByProviderEnabledModels<T extends { id: string; provider: string }>(
  available: T[],
  config: Record<string, unknown> | undefined,
): T[] {
  const providers = (config?.providers ?? {}) as Record<string, { enabledModels?: unknown }>;
  const byProvider = new Map<string, Set<string>>();
  for (const [providerId, entry] of Object.entries(providers)) {
    // Absent → no filter (all models). An empty array is explicit: disable every model.
    if (!Array.isArray(entry?.enabledModels)) continue;
    const ids = new Set<string>();
    for (const ref of entry.enabledModels) {
      if (typeof ref === "string") {
        const stripped = stripThinkingSuffix(ref);
        if (stripped) ids.add(stripped);
      }
    }
    byProvider.set(providerId, ids);
  }
  if (byProvider.size === 0) return available;
  return available.filter((m) => {
    const ids = byProvider.get(m.provider);
    if (!ids) return true;
    return ids.has(m.id) || ids.has(`${m.provider}/${m.id}`);
  });
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

async function projectModelsList(
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
  catalog: ModelCatalogStatus,
): Promise<ModelsListResult> {
  const available = [...(await modelRuntime.getAvailable())];
  const enabledModels = settings.getEnabledModels();
  let modelsConfig: Record<string, unknown> | undefined;
  try {
    modelsConfig = readModelsJson();
  } catch {
    // A corrupt models.json must not break model listing; the editor surfaces the parse error.
    modelsConfig = undefined;
  }
  const visible = filterByProviderEnabledModels(filterByExactEnabledModels(available, enabledModels), modelsConfig);
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

  return { models, defaultModel, thinkingLevels, thinkingLevelMaps, nameMap, catalog };
}

export function registerHandlers(server: RpcServer): () => Promise<void> {
  const fileWatch = createFileWatchService(server);
  const authLogin = createAuthLoginService(server);
  const channelManager = new ChannelManager(server, (session, sessionId) =>
    ensureSessionEvents(server, session, sessionId),
  );
  void channelManager.initialize();

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

    "sessions.list": async () => {
      const traceId = resolveSessionTraceId();
      const startedAt = performance.now();
      try {
        const sessions = await listAllSessions();
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

      const tempKey = `__new__${Date.now()}`;
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
      let hardTruncated = false;

      try {
        const all = await listGitFiles(root);
        if (all.length > 50_000) {
          hardTruncated = true;
          relFiles = all.slice(0, 50_000);
        } else {
          relFiles = all;
        }
      } catch {
        const abs: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 8 || abs.length >= 5000) {
            if (abs.length >= 5000) hardTruncated = true;
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
              hardTruncated = true;
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
      const truncated = hardTruncated || relFiles.length > CLIENT_CAP;
      const entries = buildEntriesFromFiles(filesForClient);

      if (query?.trim()) {
        const matches = filterFileEntries(entries, query.trim()).slice(0, 50);
        return {
          files: filesForClient,
          truncated,
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
      const { services, catalog } = await modelCatalogRefreshCoordinator.refresh(cwd, requestId, (signal) =>
        createAgentSessionServices({ cwd, agentDir, modelRuntimeSignal: signal }),
      );
      return projectModelsList(services.modelRuntime, services.settingsManager, catalog);
    },

    "models.refreshCancel": (params) => {
      const { requestId } = params as { requestId: string };
      return { ok: true as const, cancelled: modelCatalogRefreshCoordinator.cancel(requestId) };
    },

    "models.preferences.get": async (params) => {
      const cwd = resolveModelsCwd(params as { cwd?: string } | void);
      const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
      const available = await services.modelRuntime.getAvailable();
      return projectModelPreferences(available, services.settingsManager.getEnabledModels());
    },

    "models.preferences.set": async (params) => {
      const body = params as { cwd?: string; enabledModels?: unknown };
      const cwd = resolveModelsCwd(body);
      const enabledModels = normalizeEnabledModelsInput(body.enabledModels);
      const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
      const available = await services.modelRuntime.getAvailable();
      if (enabledModels && !hasMatchingEnabledModel(available, enabledModels)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "At least one available model must remain enabled" });
      }
      services.settingsManager.setEnabledModels(enabledModels);
      return projectModelPreferences(available, enabledModels);
    },

    "modelsConfig.get": () => readModelsJson() as never,
    "modelsConfig.set": async (params) => {
      const body = params as Record<string, unknown>;
      // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
      if (!body || typeof body !== "object" || !("providers" in body)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
      }
      writeModelsJson(body);
      await reloadSharedModelRuntimeConfig();
      return { ok: true as const };
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

    "modelsConfig.providers": async () => {
      const defaults = getBuiltinProviderDefaults();
      const config = readModelsJson();
      const runtime = await getSharedModelRuntime();
      const result = [...defaults.values()]
        .map((defaultProvider) => {
          const overlay = getProviderOverlay(config, defaultProvider.id, defaultProvider.baseUrl);
          const composed = runtime.getProvider(defaultProvider.id);
          const modelCount = (composed?.getModels() ?? defaultProvider.getModels()).length;
          const auth = runtime.getProviderAuthStatus(defaultProvider.id);
          return {
            id: defaultProvider.id,
            name: composed?.name ?? defaultProvider.name,
            defaultBaseUrl: defaultProvider.baseUrl,
            ...(overlay.customBaseUrl ? { customBaseUrl: overlay.customBaseUrl } : {}),
            ...(overlay.enabledModels ? { enabledModels: overlay.enabledModels } : {}),
            modelCount,
            api: defaultProvider.api,
            // True when the provider has usable credentials (stored API key / OAuth
            // token / models.json key / environment variable).
            configured: auth?.configured ?? false,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { providers: result };
    },

    "modelsConfig.providerModels": async (params) => {
      const { providerId } = params as { providerId?: string };
      const id = typeof providerId === "string" ? providerId.trim() : "";
      if (!id) throw new RpcError({ code: "BAD_REQUEST", message: "providerId is required" });
      const defaults = getBuiltinProviderDefaults();
      const defaultProvider = defaults.get(id);
      if (!defaultProvider) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown built-in provider: ${id}` });
      }
      const config = readModelsJson();
      const overlay = getProviderOverlay(config, id, defaultProvider.baseUrl);
      const runtime = await getSharedModelRuntime();
      const composed = runtime.getProvider(id);
      const models = (composed?.getModels() ?? defaultProvider.getModels()).map((m) => ({ id: m.id, name: m.name }));
      return {
        provider: {
          id: defaultProvider.id,
          name: composed?.name ?? defaultProvider.name,
          defaultBaseUrl: defaultProvider.baseUrl,
          ...(overlay.customBaseUrl ? { customBaseUrl: overlay.customBaseUrl } : {}),
          api: defaultProvider.api,
        },
        models,
        // null = no filter (all models enabled by default)
        enabledModels: overlay.enabledModels ?? null,
      };
    },

    "modelsConfig.setProviderOverlay": async (params) => {
      const body = params as { providerId?: string; baseUrl?: string; enabledModels?: string[] };
      const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
      if (!providerId) throw new RpcError({ code: "BAD_REQUEST", message: "providerId is required" });
      const defaults = getBuiltinProviderDefaults();
      const defaultProvider = defaults.get(providerId);
      if (!defaultProvider) {
        throw new RpcError({ code: "NOT_FOUND", message: `Unknown built-in provider: ${providerId}` });
      }
      const config = readModelsJson();
      const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
      const next = { ...(providers[providerId] ?? {}) };

      if (body.baseUrl !== undefined) {
        const trimmed = body.baseUrl.trim();
        if (trimmed && trimmed !== defaultProvider.baseUrl) next.baseUrl = trimmed;
        else delete next.baseUrl;
      }
      if (body.enabledModels !== undefined) {
        if (body.enabledModels === null) {
          delete next.enabledModels;
        } else {
          const list = [...new Set(body.enabledModels.map((m) => m.trim()).filter(Boolean))];
          // Empty array is explicit: disable every model (absent means all enabled).
          next.enabledModels = list;
        }
      }

      // pi-ai validates provider entries and rejects a config with no meaningful
      // fields; `enabledModels` alone is not one of them. Anchor with the default
      // Base URL (a no-op override) so a model-only toggle still loads.
      const meaningful = Object.keys(next).filter((k) => k !== "enabledModels");
      if (Object.keys(next).length > 0 && meaningful.length === 0) {
        next.baseUrl = defaultProvider.baseUrl;
      }
      // Drop empty entries and entries that only anchor the default Base URL.
      if (
        Object.keys(next).length === 0 ||
        (Object.keys(next).length === 1 && next.baseUrl === defaultProvider.baseUrl)
      ) {
        delete providers[providerId];
      } else {
        providers[providerId] = next;
      }

      writeModelsJson(config);
      await reloadSharedModelRuntimeConfig();
      return { ok: true as const };
    },

    "modelsConfig.fetchModels": async (params) => {
      const body = params as { baseUrl?: string; apiKey?: string };
      const rawBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (!rawBaseUrl) return { ok: false as const, error: "Base URL is required" };
      let base: URL;
      try {
        base = new URL(rawBaseUrl);
      } catch {
        return { ok: false as const, error: "Invalid Base URL — expected https://api.example.com/v1" };
      }
      if (base.protocol !== "https:" && base.protocol !== "http:") {
        return { ok: false as const, error: "Base URL must start with http:// or https://" };
      }
      const modelsUrl = `${base.toString().replace(/\/+$/, "")}/models`;
      // Google Generative Language API (generativelanguage.googleapis.com) uses a
      // different auth header (x-goog-api-key), returns models as "models/<id>"
      // entries, and paginates via nextPageToken — handle it specially.
      const isGoogle =
        base.hostname === "generativelanguage.googleapis.com" ||
        base.hostname.endsWith(".generativelanguage.googleapis.com");
      const apiKey = resolveConfigValueSafely(typeof body.apiKey === "string" ? body.apiKey : undefined);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        if (isGoogle) {
          headers["x-goog-api-key"] = apiKey;
        } else {
          // Cover both OpenAI-compatible (Bearer) and Anthropic-compatible (x-api-key) endpoints.
          headers["Authorization"] = `Bearer ${apiKey}`;
          headers["x-api-key"] = apiKey;
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const collected: BuiltinModelInfo[] = [];
        let pageToken: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          let url = modelsUrl;
          if (isGoogle) {
            const u = new URL(modelsUrl);
            u.searchParams.set("pageSize", "100");
            if (pageToken) u.searchParams.set("pageToken", pageToken);
            url = u.toString();
          }
          const response = await fetch(url, { headers, signal: controller.signal });
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            const detail = extractApiErrorBody(text);
            return {
              ok: false as const,
              error: detail ? `HTTP ${response.status}: ${detail}` : `Request failed with HTTP ${response.status}`,
              status: response.status,
            };
          }
          const data: unknown = await response.json().catch(() => null);
          const models = parseModelsResponse(data);
          if (page === 0 && models.length === 0) {
            return {
              ok: false as const,
              error: 'The response did not contain a model list (expected { "data": [...] })',
            };
          }
          const seen = new Set(collected.map((m) => m.id));
          for (const model of models) {
            if (!seen.has(model.id)) {
              seen.add(model.id);
              collected.push(model);
            }
          }
          if (!isGoogle) break;
          const token = (data as { nextPageToken?: unknown } | null)?.nextPageToken;
          if (typeof token !== "string" || !token) break;
          pageToken = token;
        }
        return { ok: true as const, models: collected };
      } catch (e) {
        if (controller.signal.aborted) return { ok: false as const, error: "Request timed out after 15 seconds" };
        const raw = e instanceof Error ? e.message : String(e);
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
        const detail = cause && !raw.includes(cause) ? `${raw} — ${cause}` : raw;
        const friendly = /ENOTFOUND|EAI_AGAIN/.test(detail)
          ? "Could not resolve the host — check the Base URL"
          : /ECONNREFUSED|ECONNRESET/.test(detail)
            ? "Connection refused — is the endpoint reachable?"
            : detail;
        return { ok: false as const, error: friendly };
      } finally {
        clearTimeout(timer);
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
      if (!token.startsWith(`${provider}-`)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Token does not match provider" });
      }
      if (!resolveLoginCode(token, code)) {
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
      const key = "disable-model-invocation";
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
      const alreadySet = Boolean(frontmatter[key]);
      let updated = content;
      if (body.disableModelInvocation === true && !alreadySet) {
        updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
        if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
      } else if (body.disableModelInvocation === false && alreadySet) {
        updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
      }
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

    "files.watchStart": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await fileWatch.start(filePath, sourceSessionId);
      return { ok: true as const };
    },

    "files.watchStop": async (params) => {
      const { path: filePath } = params as { path: string };
      fileWatch.stop(filePath);
      return { ok: true as const };
    },

    "system.home": () => ({ home: homedir() }),

    "system.validateCwd": async (params) => {
      const { path: dir } = params as { path: string };
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) return { ok: false, error: "Not a directory" };
        allowFileRoot(dir);
        invalidateAllowedRootsCache();
        return { ok: true, path: dir };
      } catch {
        return { ok: false, error: "Directory does not exist" };
      }
    },

    "system.defaultCwd": async () => {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const dir = path.join(homedir(), `pi-cwd-${date}`);
      mkdirSync(dir, { recursive: true });
      allowFileRoot(dir);
      invalidateAllowedRootsCache();
      return { cwd: dir };
    },

    "system.allowRoot": async (params) => {
      const { path: dir } = params as { path: string };
      allowFileRoot(dir);
      invalidateAllowedRootsCache();
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
  };
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
    onDestroy?: (cb: () => void) => void;
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
