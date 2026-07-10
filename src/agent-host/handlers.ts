/**
 * Register all Api handlers on the RPC server.
 * Ports logic from the old Next.js API routes onto the Host process.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
  parseFrontmatter,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed, isWindowsAbsolutePath, normalizeSlashes } from "./file-access";
import {
  getRpcSession,
  getRunningRpcSessionIds,
  startRpcSession,
  subscribeRunningSessions,
} from "./rpc-manager";
import {
  buildSessionContext,
  invalidateSessionPathCache,
  listAllSessions,
  resolveSessionPath,
} from "./session-reader";
import { isFilePathReferencedBySession } from "./session-file-references";
import { addWorktree, listWorktrees, removeWorktree, resolveProject } from "../shared/worktree";
import { buildEntriesFromFiles, filterFileEntries } from "../shared/file-fuzzy";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "../shared/file-types";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", txt: "text",
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
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const p = getModelsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
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

// OAuth login callback registry
const loginCallbacks = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();

const MAX_PROJECTED_TREE_DEPTH = 200;

function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[],
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (roots.has(node) || node.children.length !== 1) keep.add(node);
    for (const child of node.children) stack.push(child);
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;
    for (const sourceChild of source.children) {
      let child = sourceChild;
      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        projected.children.push(cloneNode(child));
        continue;
      }
      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }
      const projectedChild = cloneNode(child, compressedEntryIds.length ? compressedEntryIds : undefined);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }
  return projectedRoots;
}

export function registerHandlers(server: RpcServer): void {
  // Running sessions stream
  subscribeRunningSessions((ids) => {
    server.emit("agent.running", "*", { type: "running", sessionIds: ids });
  });

  server.handle({
    "host.ping": () => ({ ok: true as const, ts: Date.now() }),

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
      const header = sm.getHeader();
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
      const { id } = params as { id: string };
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const existing = getRpcSession(id);
      existing?.destroy();
      unlinkSync(filePath);
      invalidateSessionPathCache(id);
      server.emit("sessions.changed", "*", { cwd: null });
      return { ok: true as const };
    },

    "sessions.rename": async (params) => {
      const { id, name } = params as { id: string; name: string };
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        await existing.send({ type: "set_session_name", name });
      } else {
        const filePath = await resolveSessionPath(id);
        if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
        const sm = SessionManager.open(filePath);
        sm.setSessionName?.(name);
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
        worktrees: worktrees as never,
        projectRoot: project.projectRoot,
        isGit,
        isTopLevel: project.isTopLevel,
      } as never;
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
      return { worktree: result as never };
    },

    "worktrees.remove": async (params) => {
      const body = params as { path: string; cwd?: string; force?: boolean };
      const cwd = body.cwd ?? body.path;
      const allowed = await getAllowedFileRoots();
      if (!isFilePathAllowed(cwd, allowed)) {
        throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
      }
      await removeWorktree(cwd, body.path, body.force === true);
      return { ok: true as const };
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

      // Subscribe session events to stream
      session.onEvent((event) => {
        server.emit("agent.events", realSessionId, event as never);
        if (event.type === "agent_end" || event.type === "prompt_done") {
          // Host can't call Notification API — renderer/main handles via badge hooks
        }
      });

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

    "files.list": async (params) => {
      const { path: dirPath } = params as { path: string };
      await assertPathAllowed(dirPath);
      if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
        throw new RpcError({ code: "NOT_FOUND", message: "Directory not found" });
      }
      const names = readdirSync(dirPath);
      const entries: Array<{ name: string; isDir: boolean; size?: number; mtime?: number; path: string; type: "file" | "directory" }> = [];
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
      if (st.size > TEXT_PREVIEW_MAX_BYTES) {
        return {
          content: readFileSync(filePath, "utf8").slice(0, TEXT_PREVIEW_MAX_BYTES),
          language: getLanguage(filePath),
          size: st.size,
          truncated: true,
        };
      }
      return {
        content: readFileSync(filePath, "utf8"),
        language: getLanguage(filePath),
        size: st.size,
        truncated: false,
      };
    },

    "files.meta": async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      return {
        size: st.size,
        mtime: st.mtimeMs,
        language: getLanguage(filePath),
        kind: documentPreviewKind(filePath) ?? getImageMime(filePath) ? "image" : "file",
        mime: getImageMime(filePath) ?? getDocumentMime(filePath) ?? getAudioMime(filePath),
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
      if (imgMime && st.size <= IMAGE_PREVIEW_MAX_BYTES) {
        return {
          kind: "image",
          mime: imgMime,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      const docKind = documentPreviewKind(filePath);
      if (docKind === "docx" && st.size <= DOCX_PREVIEW_MAX_BYTES) {
        return {
          kind: "docx",
          mime: getDocumentMime(filePath),
          // Renderer loads mammoth; send base64 for conversion
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      return {
        kind: "text",
        content: readFileSync(filePath, "utf8").slice(0, TEXT_PREVIEW_MAX_BYTES),
        language: getLanguage(filePath),
      };
    },

    "files.index": async (params) => {
      const { root, query } = params as { root: string; query?: string };
      await assertPathAllowed(root);
      const files: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || files.length >= 5000) return;
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
            else files.push(full);
          } catch {
            /* skip */
          }
          if (files.length >= 5000) return;
        }
      };
      walk(root, 0);
      const entries = buildEntriesFromFiles(files, root);
      const matches = query ? filterFileEntries(entries, query).slice(0, 50) : entries.slice(0, 100);
      return {
        matches: matches.map((m) => ({
          path: typeof m === "string" ? m : (m as { path?: string }).path ?? String(m),
          score: typeof m === "object" && m && "score" in m ? Number((m as { score: number }).score) : 0,
          ...(typeof m === "object" ? m : {}),
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
      const registry = services.modelRegistry;
      const available = registry.getAvailable();
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
    "modelsConfig.set": (params) => {
      writeModelsJson(params as Record<string, unknown>);
      return { ok: true as const };
    },
    "modelsConfig.test": async (params) => {
      const { provider } = params as { provider: string };
      try {
        const auth = AuthStorage.create();
        const has = auth.has(provider);
        return { ok: has, error: has ? undefined : `No credentials for ${provider}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    "auth.providers": async () => {
      const authStorage = AuthStorage.create();
      const providers = authStorage.getOAuthProviders();
      const EXCLUDED = new Set(["anthropic"]);
      const DISPLAY_NAMES: Record<string, string> = {
        "openai-codex": "ChatGPT Plus/Pro",
        "github-copilot": "GitHub Copilot",
      };
      const result = providers
        .filter((p) => !EXCLUDED.has(p.id))
        .map((p) => ({
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: p.usesCallbackServer ?? false,
          authenticated: authStorage.has(p.id),
          loggedIn: authStorage.has(p.id),
        }));
      return { providers: result };
    },

    "auth.allProviders": async () => {
      // Simplified: return same OAuth set + API-key style from models.json
      const authStorage = AuthStorage.create();
      const oauth = authStorage.getOAuthProviders().map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: authStorage.has(p.id),
        type: "oauth",
      }));
      return { providers: oauth };
    },

    "auth.setApiKey": async (params) => {
      const { provider, key } = params as { provider: string; key: string };
      const authStorage = AuthStorage.create();
      authStorage.set?.(provider, key) ??
        // Fallback: write into models.json env-style if set API not available
        (() => {
          const models = readModelsJson();
          const providers = (models.providers as Record<string, unknown>) ?? {};
          providers[provider] = { ...(providers[provider] as object), apiKey: key };
          models.providers = providers;
          writeModelsJson(models);
        })();
      return { ok: true as const };
    },

    "auth.deleteApiKey": async (params) => {
      const { provider } = params as { provider: string };
      try {
        const authStorage = AuthStorage.create();
        authStorage.logout?.(provider);
      } catch {
        /* ignore */
      }
      return { ok: true as const };
    },

    "auth.logout": async (params) => {
      const { provider } = params as { provider: string };
      const authStorage = AuthStorage.create();
      if (typeof authStorage.logout === "function") {
        await authStorage.logout(provider);
      }
      return { ok: true as const };
    },

    "auth.loginSubmit": async (params) => {
      const { provider, token, code } = params as {
        provider: string;
        token: string;
        code: string;
      };
      const callbacks = loginCallbacks.get(token);
      if (!callbacks) {
        throw new RpcError({ code: "NOT_FOUND", message: "No pending login for token" });
      }
      if (!token.startsWith(`${provider}-`)) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Token does not match provider" });
      }
      callbacks.resolve(code);
      loginCallbacks.delete(token);
      return { ok: true as const };
    },

    "skills.list": async (params) => {
      const cwd = (params as { cwd?: string } | void)?.cwd;
      if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      return { skills, diagnostics } as never;
    },

    "skills.search": async (params) => {
      const { query } = params as { query: string };
      // Best-effort: return empty if skills registry not available offline
      return { results: [], query } as never;
    },

    "skills.install": async () => {
      throw new RpcError({
        code: "NOT_IMPLEMENTED",
        message: "skills.install will be wired via ELECTRON_RUN_AS_NODE npx in M4",
      });
    },

    "skills.set": async (params) => {
      const body = params as { filePath: string; disableModelInvocation: boolean };
      const { filePath, disableModelInvocation } = body;
      if (!filePath || !existsSync(filePath)) {
        throw new RpcError({ code: "NOT_FOUND", message: "file not found" });
      }
      const content = readFileSync(filePath, "utf8");
      const key = "disable-model-invocation";
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
      const alreadySet = Boolean(frontmatter[key]);
      let updated = content;
      if (disableModelInvocation && !alreadySet) {
        updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
        if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
      } else if (!disableModelInvocation && alreadySet) {
        updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
      }
      writeFileSync(filePath, updated, "utf8");
      return { ok: true as const };
    },

    "plugins.list": async (params) => {
      // Minimal stub — full plugin manager ported in M4
      const cwd = (params as { cwd?: string } | void)?.cwd;
      return {
        packages: [],
        totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
        diagnostics: [],
        cwd,
      };
    },

    "plugins.set": async () => ({ ok: true as const }),

    "system.home": () => ({ home: homedir() }),

    "system.validateCwd": async (params) => {
      const { path: dir } = params as { path: string };
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) return { ok: false, error: "Not a directory" };
        allowFileRoot(dir);
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
      return { cwd: dir };
    },
  });
}

const eventAttached = new Set<string>();

function ensureSessionEvents(
  server: RpcServer,
  session: { sessionId: string; onEvent: (l: (e: { type: string; [k: string]: unknown }) => void) => () => void },
  sessionId: string,
): void {
  const key = session.sessionId || sessionId;
  if (eventAttached.has(key)) return;
  eventAttached.add(key);
  session.onEvent((event) => {
    server.emit("agent.events", key, event as never);
  });
}

export { loginCallbacks };

// silence unused imports in some builds
void isWindowsAbsolutePath;
void normalizeSlashes;
void getFileExt;
