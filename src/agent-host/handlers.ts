/**
 * Register all Api handlers on the RPC server.
 * Implements the desktop RPC contract in the Agent Host process.
 */
import { modelCatalogHandlers, type AvailableModel } from "./handlers/model-catalog";
import { modelConfigHandlers } from "./handlers/models-config";
import { createAuthHandlers } from "./handlers/auth";
import { createFileHandlers } from "./handlers/files";
import { createWorktreeHandlers } from "./handlers/worktrees";
import { systemHandlers } from "./handlers/system";
import { createSessionHandlers } from "./handlers/sessions";
import { emitIndexedSessionChange } from "./session-change";
import { assertPathAllowed } from "./path-authorization";
import { validateExistingDirectory } from "./directory-validation";
export { projectModelsList } from "./handlers/model-catalog";
export { credentialMutationFailure } from "./handlers/auth";
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { readSessionSnapshot, assertSessionWritable } from "./session-readonly.ts";
import {
  AUTO_TITLE_MAX_LENGTH,
  makeFallbackTitle,
  messageContentText,
  sanitizeGeneratedTitle,
  takeCodePoints,
} from "./session-title";
import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";
import { allowFileRoot } from "./file-access";
import {
  disposeAllRpcSessions,
  getRpcSession,
  startRpcSession,
  subscribeRunningSessions,
  syncDesktopToolsForAllSessions,
} from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { createFileWatchService, stopAllFileWatches } from "./file-watch";
import { createAuthLoginService } from "./auth-login";
import { modelCatalogRefreshCoordinator } from "./model-runtime";
import { applyPluginAction, readPlugins } from "./plugins-service";
import { installSkill, searchSkills } from "./skills-service";
import { updateSkillModelInvocation } from "./skill-frontmatter";
import { ChannelManager } from "./channels/channel-manager";
import { safeChannelError } from "./channels/redaction";
import { ToolchainError } from "../shared/toolchains/errors";
import { toolchainRuntime } from "./toolchain-runtime";
import { invalidateSessionContent } from "./session-content-cache";
import { cacheWarmingSettings, isCacheWarmingMode } from "./cache-warming-settings";
import { initializeManagedProcessService } from "./managed-process/runtime";
import { ManagedProcessError } from "./managed-process/service";
import type {
  ManagedProcessReadParams,
  ManagedProcessWaitParams,
  ManagedProcessWriteParams,
} from "../contract/processes";
import { HerdrBridgeError } from "./herdr/errors";
import { clearHerdrBridge, initializeHerdrBridge } from "./herdr/runtime";
import type { HerdrSettings } from "../contract/herdr";

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

// ============================================================================
// Auto session title — silent LLM request that never touches session history.
// ============================================================================

const AUTO_TITLE_REQUEST_MAX_CHARS = 2000;
const AUTO_TITLE_MAX_TOKENS = 60;
const AUTO_TITLE_TIMEOUT_MS = 15_000;
const AUTO_TITLE_SYSTEM_PROMPT =
  "You create a concise session title from the user's first message. " +
  "Rules: match the language of the message; return only a short noun phrase " +
  `of at most ${AUTO_TITLE_MAX_LENGTH} characters; no quotes, no trailing punctuation, no Markdown.`;

type TitleSessionServices = Awaited<ReturnType<typeof createAgentSessionServices>>;
type TitleModelServices = Pick<TitleSessionServices, "modelRuntime" | "settingsManager">;

function resolveTitleModel(
  services: TitleModelServices,
  provider?: string,
  modelId?: string,
): AvailableModel | undefined {
  const runtime = services.modelRuntime;
  if (provider && modelId) {
    const byRef = runtime.getModel(provider, modelId);
    if (byRef) return byRef as AvailableModel;
  }
  const settings = services.settingsManager;
  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  if (defaultProvider && defaultModelId) {
    const byDefault = runtime.getModel(defaultProvider, defaultModelId);
    if (byDefault) return byDefault as AvailableModel;
  }
  return runtime.getAvailableSnapshot()[0];
}

async function generateSessionTitle(
  services: TitleModelServices,
  message: string,
  provider?: string,
  modelId?: string,
): Promise<string | null> {
  const model = resolveTitleModel(services, provider, modelId);
  if (!model) return null;
  try {
    const assistant = await services.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: takeCodePoints(message, AUTO_TITLE_REQUEST_MAX_CHARS),
            timestamp: Date.now(),
          },
        ],
      },
      {
        // Standalone request: never reuse or write prompt-cache entries.
        cacheRetention: "none",
        maxTokens: AUTO_TITLE_MAX_TOKENS,
        sessionId: randomUUID(),
        signal: AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS),
      },
    );
    return sanitizeGeneratedTitle(messageContentText(assistant.content));
  } catch {
    return null;
  }
}

export async function generateSessionTitleWithFallback(
  createServices: () => Promise<TitleModelServices>,
  message: string,
  provider?: string,
  modelId?: string,
): Promise<string> {
  try {
    const services = await createServices();
    const generated = await generateSessionTitle(services, message, provider, modelId);
    return generated ?? makeFallbackTitle(message);
  } catch {
    // Service creation can fail before a model request starts (for example,
    // while loading project resources). The local fallback must still apply.
    return makeFallbackTitle(message);
  }
}

async function hasSessionName(sessionId: string): Promise<boolean> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) {
    const name = existing.inner.sessionName;
    return typeof name === "string" && name.trim().length > 0;
  }
  try {
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) return false;
    const storedName = readSessionSnapshot(filePath).getSessionName();
    return typeof storedName === "string" && storedName.trim().length > 0;
  } catch {
    return false;
  }
}

function applyLiveSessionNameIfEmpty(sessionId: string, name: string): boolean | null {
  const existing = getRpcSession(sessionId);
  if (!existing?.isAlive()) return null;
  const currentName = existing.inner.sessionName;
  if (typeof currentName === "string" && currentName.trim().length > 0) return false;

  // Keep the check and write in the same synchronous turn. A manual rename
  // that ran first is observed above; one that runs later overwrites this
  // automatic value, so the manual choice always wins.
  existing.inner.setSessionName(name);
  return true;
}

export async function applySessionNameIfEmpty(sessionId: string, name: string): Promise<boolean> {
  const normalized = name.trim();
  if (!normalized) return false;

  const liveResult = applyLiveSessionNameIfEmpty(sessionId, normalized);
  if (liveResult !== null) return liveResult;

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;

  // The session may have become live while its path was resolving.
  const liveResultAfterLookup = applyLiveSessionNameIfEmpty(sessionId, normalized);
  if (liveResultAfterLookup !== null) return liveResultAfterLookup;

  assertSessionWritable(filePath);
  const manager = SessionManager.open(filePath, undefined);
  const storedName = manager.getSessionName();
  if (typeof storedName === "string" && storedName.trim().length > 0) return false;

  // SessionManager's read and append are synchronous, so another Renderer RPC
  // cannot interleave a manual rename between this final check and the write.
  manager.appendSessionInfo(normalized);
  invalidateSessionContent(filePath);
  return true;
}

async function resolveTitleSessionTarget(
  sessionId: string,
): Promise<{ cwd: string; services?: TitleModelServices } | null> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) {
    const dir = validateExistingDirectory(existing.cwd);
    if (!dir.ok) return null;
    return {
      cwd: dir.path,
      services: {
        modelRuntime: existing.inner.modelRuntime as unknown as TitleSessionServices["modelRuntime"],
        settingsManager: existing.inner.settingsManager,
      },
    };
  }

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  const cwd = readSessionSnapshot(filePath).getHeader()?.cwd;
  const dir = validateExistingDirectory(cwd);
  return dir.ok ? { cwd: dir.path } : null;
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

export function assertHerdrParamKeys(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === undefined && allowedKeys.length === 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Herdr request parameters are invalid.");
  }
  const params = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(params).some((key) => !allowed.has(key))) {
    throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Herdr request contains an unsupported parameter.");
  }
  return params;
}

export function registerHandlers(server: RpcServer): () => Promise<void> {
  const fileWatch = createFileWatchService(server);
  const fileHandlers = createFileHandlers(fileWatch);
  const authLogin = createAuthLoginService(server);
  const authHandlers = createAuthHandlers(authLogin);
  const channelManager = new ChannelManager(server, (session, sessionId) =>
    ensureSessionEvents(server, session, sessionId),
  );
  initializeChannels(channelManager);
  const managedProcesses = initializeManagedProcessService(server);
  const worktreeHandlers = createWorktreeHandlers(managedProcesses);
  const sessionHandlers = createSessionHandlers({ server, managedProcesses, clearSessionEventBinding });
  const herdr = initializeHerdrBridge(server, { assertAllowedPath: (target) => assertPathAllowed(target) });
  const stopHerdrToolSync = herdr.subscribeRuntime(() => syncDesktopToolsForAllSessions());

  const managedCall = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ManagedProcessError) {
        throw new RpcError({ code: error.code, message: error.message, detail: error.details });
      }
      throw error;
    }
  };
  const herdrCall = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HerdrBridgeError) {
        throw new RpcError({ code: error.code, message: error.message, detail: error.toPublic() });
      }
      throw error;
    }
  };

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

    "herdr.runtime.get": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.getRuntime();
      }),

    "herdr.runtime.configure": (params) =>
      herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["settings"]) as { settings: HerdrSettings };
        return herdr.configure(body.settings);
      }),

    "herdr.runtime.probe": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.probe();
      }),

    "herdr.runtime.restart": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.restartManagedServer();
      }),

    "herdr.runtime.connect": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.connect();
      }),

    "herdr.runtime.disconnect": (params) =>
      herdrCall(async () => {
        assertHerdrParamKeys(params, []);
        await herdr.disconnect(false);
        return { ok: true as const };
      }),

    "herdr.diagnostics": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.getDiagnostics();
      }),

    "herdr.snapshot": (params) =>
      herdrCall(() => {
        assertHerdrParamKeys(params, []);
        return herdr.refreshSnapshot();
      }),

    "herdr.workspace.create": async (params) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["cwd", "name"]) as { cwd: string; name?: string };
        if (
          typeof body.cwd !== "string" ||
          !body.cwd ||
          body.cwd.length > 4_096 ||
          /[\0\r\n]/.test(body.cwd) ||
          (body.name !== undefined &&
            (typeof body.name !== "string" ||
              !body.name.trim() ||
              body.name.length > 256 ||
              /[\0\r\n]/.test(body.name)))
        ) {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace parameters are invalid.");
        }
        await assertPathAllowed(body.cwd);
        return herdr.createWorkspace(body.cwd, body.name);
      });
    },

    "herdr.pane.split": async (params) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["paneId", "direction", "cwd"]) as {
          paneId?: string;
          direction?: "horizontal" | "vertical";
          cwd?: string;
        };
        if (body.cwd !== undefined) {
          if (typeof body.cwd !== "string" || !body.cwd || body.cwd.length > 4_096 || /[\0\r\n]/.test(body.cwd)) {
            throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Pane split parameters are invalid.");
          }
          await assertPathAllowed(body.cwd);
        }
        return herdr.splitPane(body.paneId!, body.direction!, body.cwd);
      });
    },

    "herdr.pane.read": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "maxBytes"]) as {
          paneId?: string;
          maxBytes?: number;
        };
        return herdr.readPane(body.paneId!, body.maxBytes);
      });
    },

    "herdr.agent.start": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "kind"]);
        return herdr.startAgent(body.paneId as string, body.kind);
      });
    },

    "herdr.agent.prompt": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "prompt"]);
        return herdr.promptAgent(body.paneId as string, body.prompt);
      });
    },

    "herdr.agent.sendKeys": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "keys"]);
        return herdr.sendAgentKeys(body.paneId as string, body.keys);
      });
    },

    "herdr.agent.wait": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["paneId", "states", "timeoutMs", "requestId"]);
        return herdr.waitAgent(body.paneId as string, body.states, body.timeoutMs, body.requestId);
      });
    },

    "herdr.agent.waitCancel": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["requestId"]);
        herdr.cancelWait(body.requestId);
        return { ok: true as const };
      });
    },

    "herdr.terminal.open": (params, context) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["paneId", "mode", "cols", "rows", "takeover"]) as {
          paneId?: string;
          mode?: "observe" | "control";
          cols?: number;
          rows?: number;
          takeover?: boolean;
        };
        if (body.takeover !== undefined && typeof body.takeover !== "boolean") {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal takeover must be a boolean.");
        }
        const result = await herdr.openTerminal(body.paneId!, body.mode!, body.cols!, body.rows!, body.takeover);
        context?.setLease(`herdr.terminal:${result.terminalId}`, () => {
          herdr.getTerminals().scheduleOrphanRelease(result.terminalId);
        });
        return result;
      });
    },

    "herdr.terminal.input": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "bytes"]) as {
          terminalId?: string;
          bytes?: Uint8Array;
        };
        herdr.getTerminals().get(body.terminalId!).input(body.bytes!);
        return { accepted: true as const };
      });
    },

    "herdr.terminal.resize": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "cols", "rows"]) as {
          terminalId?: string;
          cols?: number;
          rows?: number;
        };
        herdr.getTerminals().get(body.terminalId!).resize(body.cols!, body.rows!);
        return { accepted: true as const };
      });
    },

    "herdr.terminal.ack": (params) => {
      return herdrCall(() => {
        const body = assertHerdrParamKeys(params, ["terminalId", "seq"]) as {
          terminalId?: string;
          seq?: number;
        };
        herdr.getTerminals().get(body.terminalId!).ack(body.seq!);
        return { ok: true as const };
      });
    },

    "herdr.terminal.close": (params, context) => {
      return herdrCall(async () => {
        const body = assertHerdrParamKeys(params, ["terminalId", "release"]) as {
          terminalId?: string;
          release?: boolean;
        };
        if (typeof body.release !== "boolean") {
          throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal release must be a boolean.");
        }
        context?.releaseLease(`herdr.terminal:${body.terminalId!}`);
        await herdr.getTerminals().close(body.terminalId!, body.release === true);
        return { ok: true as const };
      });
    },

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

    "processes.list": (params) =>
      managedCall(() =>
        managedProcesses.list((params as { includeExited?: boolean } | undefined)?.includeExited === true),
      ),

    "processes.get": (params) => managedCall(() => managedProcesses.get((params as { processId: string }).processId)),

    "processes.read": (params) =>
      managedCall(() => managedProcesses.read(params as ManagedProcessReadParams, undefined, true)),

    "processes.wait": (params) =>
      managedCall(() => managedProcesses.wait(params as ManagedProcessWaitParams, undefined, true)),

    "processes.write": (params) => managedCall(() => managedProcesses.write(params as ManagedProcessWriteParams)),

    "processes.stop": (params) => {
      const body = params as { processId: string; runId: string; mode?: "graceful" | "force" };
      return managedCall(() => managedProcesses.stop(body.processId, body.runId, body.mode, "user"));
    },

    "processes.stopAll": (params) =>
      managedCall(async () => ({
        ok: true as const,
        stopped: await managedProcesses.stopAll(
          "user",
          (params as { mode?: "graceful" | "force" } | undefined)?.mode,
          false,
        ),
      })),

    "processes.restart": (params) => {
      const body = params as { processId: string; runId: string };
      return managedCall(() => managedProcesses.restart(body.processId, body.runId, "user"));
    },

    "processes.dismiss": (params) =>
      managedCall(() => managedProcesses.dismiss((params as { processId: string }).processId)),

    "processes.export": (params) => {
      const body = params as {
        processId: string;
        runId: string;
        streams?: Array<"stdout" | "stderr" | "system">;
      };
      return managedCall(() => managedProcesses.exportLogs(body.processId, body.runId, body.streams));
    },

    "sessions.list": sessionHandlers.list,

    "sessions.get": sessionHandlers.get,

    "sessions.context": sessionHandlers.context,

    "sessions.contextPage": sessionHandlers.contextPage,

    "sessions.entryContent": sessionHandlers.entryContent,

    "sessions.export": sessionHandlers.export,

    "sessions.delete": sessionHandlers.delete,

    "sessions.rename": sessionHandlers.rename,

    "worktrees.list": worktreeHandlers.list,

    "worktrees.create": worktreeHandlers.create,

    "worktrees.remove": worktreeHandlers.remove,

    "git.status": worktreeHandlers.status,

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
      const cwd = readSessionSnapshot(filePath).getHeader()?.cwd ?? process.cwd();
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

    "agent.generateTitle": async (params) => {
      const body = params as {
        sessionId: string;
        message: string;
        provider?: string;
        modelId?: string;
      };
      const { sessionId, message } = body;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new RpcError({ code: "BAD_REQUEST", message: "sessionId is required" });
      }
      if (typeof message !== "string" || !message.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "message is required" });
      }
      const target = await resolveTitleSessionTarget(sessionId);
      if (!target) return { title: null };

      // Never overwrite a title the user already set (or an earlier title).
      if (await hasSessionName(sessionId)) return { title: null };

      const finalTitle = await generateSessionTitleWithFallback(
        target.services
          ? async () => target.services as TitleModelServices
          : () => createAgentSessionServices({ cwd: target.cwd, agentDir: getAgentDir() }),
        message,
        body.provider,
        body.modelId,
      );

      // Check and write atomically at the live session or SessionManager edge.
      // A concurrent manual rename either runs first and blocks this write, or
      // runs afterwards and replaces the automatic title.
      if (!(await applySessionNameIfEmpty(sessionId, finalTitle))) return { title: null };

      await emitIndexedSessionChange(server, sessionId, target.cwd);
      return { title: finalTitle };
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

    "files.list": fileHandlers.list,

    "files.read": fileHandlers.read,

    "files.download": fileHandlers.download,

    "files.meta": fileHandlers.meta,

    "files.preview": fileHandlers.preview,

    "files.index": fileHandlers.index,

    "settings.getCacheWarming": async () => cacheWarmingSettings.get(),

    "settings.setCacheWarming": async (params) => {
      const mode = (params as { mode?: unknown } | undefined)?.mode;
      if (!isCacheWarmingMode(mode)) throw new RpcError({ code: "BAD_REQUEST", message: "Invalid cache warming mode" });
      try {
        return await cacheWarmingSettings.set(mode);
      } catch {
        throw new RpcError({ code: "INTERNAL", message: "Global Pi cache warming setting could not be saved" });
      }
    },

    "models.list": modelCatalogHandlers.list,

    "models.refresh": modelCatalogHandlers.refresh,

    "models.refreshCancel": modelCatalogHandlers.cancelRefresh,

    "models.preferences.get": modelCatalogHandlers.getPreferences,

    "models.preferences.set": modelCatalogHandlers.setPreferences,

    "modelsConfig.get": modelConfigHandlers.get,
    "modelsConfig.set": modelConfigHandlers.set,
    "modelsConfig.test": modelConfigHandlers.test,

    "auth.providers": authHandlers.providers,

    "auth.allProviders": authHandlers.allProviders,

    "auth.setApiKey": authHandlers.setApiKey,

    "auth.deleteApiKey": authHandlers.deleteApiKey,

    "auth.logout": authHandlers.logout,

    "auth.loginSubmit": authHandlers.submitLogin,

    "auth.loginStart": authHandlers.startLogin,

    "auth.loginCancel": authHandlers.cancelLogin,

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

    "files.watchStart": fileHandlers.startWatch,

    "files.watchStop": fileHandlers.stopWatch,

    "system.home": systemHandlers.home,

    "system.validateCwd": systemHandlers.validateCwd,

    "system.defaultCwd": systemHandlers.defaultCwd,

    "system.allowRoot": systemHandlers.allowRoot,

    "system.runningCount": systemHandlers.runningCount,
  });

  return async () => {
    modelCatalogRefreshCoordinator.cancelAll();
    stopHerdrToolSync();
    await herdr.shutdown();
    clearHerdrBridge(herdr);
    await managedProcesses.stopAll("host");
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
