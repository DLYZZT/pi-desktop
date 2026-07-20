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
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
  parseFrontmatter,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";
import { allowFileRoot, getAllowedFileRoots, invalidateAllowedRootsCache, isFilePathAllowed } from "./file-access";
import { getRpcSession, getRunningRpcSessionIds, startRpcSession, subscribeRunningSessions } from "./rpc-manager";
import { buildSessionContext, invalidateSessionPathCache, listAllSessions, resolveSessionPath } from "./session-reader";
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
import { createAuthLoginService, resolveLoginCode } from "./auth-login";
import { getSharedModelRuntime, reloadSharedModelRuntimeConfig } from "./model-runtime";
import { applyPluginAction, readPlugins } from "./plugins-service";
import { installSkill, searchSkills } from "./skills-service";
import { projectTreeForResponse } from "./project-tree";
import { ChannelManager } from "./channels/channel-manager";
import { ToolchainError } from "../shared/toolchains/errors";
import { toolchainRuntime } from "./toolchain-runtime";

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
      const sessions = await listAllSessions();
      return { sessions, runningSessionIds: getRunningRpcSessionIds() };
    },

    "sessions.get": async (params) => {
      const { id, includeState } = params as { id: string; includeState?: boolean };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });

      const sm = SessionManager.open(filePath);
      const entries = sm.getEntries() as never;
      const leafId = sm.getLeafId();
      const tree = projectTreeForResponse(sm.getTree() as never);
      const context = buildSessionContext(entries, leafId);
      const all = await listAllSessions();
      const info = all.find((s) => s.id === id);

      let agentState: { running: boolean; state?: unknown } | undefined;
      if (includeState) {
        const existing = getRpcSession(id);
        if (existing?.isAlive()) {
          const state = await existing.send({ type: "get_state" });
          agentState = { running: true, state };
        } else {
          agentState = { running: false };
        }
      }

      // Return flat SessionData shape expected by useAgentSession
      return {
        sessionId: id,
        filePath,
        info: info ?? null,
        leafId,
        tree,
        context,
        ...(agentState !== undefined ? { agentState } : {}),
      } as never;
    },

    "sessions.context": async (params) => {
      const { id, leafId } = params as { id: string; leafId?: string };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const sm = SessionManager.open(filePath);
      const context = buildSessionContext(sm.getEntries() as never, leafId);
      return { context: context as never };
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
      invalidateSessionPathCache(id);
      server.emit("sessions.changed", "*", { cwd: null });
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
      }
      server.emit("sessions.changed", "*", { cwd: null });
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
        server.emit("sessions.changed", "*", { cwd });
        return { sessionId: realSessionId, data: null };
      }

      const command = rest.type ? rest : { type: "prompt", message: body.message ?? "" };
      const data = await session.send(command as Record<string, unknown>);
      server.emit("sessions.changed", "*", { cwd });
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

    "channels.loginStart": async (params) => channelManager.startLogin(params.channel, params.force),

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
      const cwd = (params as { cwd?: string } | void)?.cwd || process.cwd();
      try {
        const st = statSync(cwd);
        if (!st.isDirectory()) {
          throw new RpcError({ code: "BAD_REQUEST", message: `Not a directory: ${cwd}` });
        }
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
      }

      const agentDir = getAgentDir();
      const services = await createAgentSessionServices({ cwd, agentDir });
      const available = [...(await services.modelRuntime.getAvailable())];
      const settings: SettingsManager = services.settingsManager;
      const enabledModels = settings.getEnabledModels();
      const visible = filterByExactEnabledModels(available, enabledModels);
      const models = visible
        .map((m: { id: string; name: string; provider: string }) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

      const nameMap: Record<string, string> = {};
      const thinkingLevels: Record<string, string[]> = {};
      const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
      for (const m of visible) {
        const key = `${m.provider}:${m.id}`;
        nameMap[key] = m.name;
        thinkingLevels[key] = getSupportedThinkingLevels(m);
        if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
      }

      let defaultModel: { provider: string; modelId: string } | null = null;
      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (provider && modelId && visible.some((m) => m.provider === provider && m.id === modelId)) {
        defaultModel = { provider, modelId };
      }

      return { models, defaultModel, thinkingLevels, thinkingLevelMaps, nameMap };
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
        throw new RpcError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const stored = await modelRuntime.listCredentials();
      if (!stored.some((entry) => entry.providerId === provider && entry.type === "api_key")) {
        throw new RpcError({
          code: "INTERNAL",
          message: `Key for ${provider} was written but not readable back`,
        });
      }
      return { ok: true as const };
    },

    "auth.deleteApiKey": async (params) => {
      const { provider } = params as { provider: string };
      try {
        const modelRuntime = await getSharedModelRuntime();
        await modelRuntime.logout(provider);
      } catch {
        /* ignore */
      }
      return { ok: true as const };
    },

    "auth.logout": async (params) => {
      const { provider } = params as { provider: string };
      const modelRuntime = await getSharedModelRuntime();
      await modelRuntime.logout(provider);
      return { ok: true as const };
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

  return () => channelManager.shutdown();
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
