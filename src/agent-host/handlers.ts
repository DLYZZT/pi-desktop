/**
 * Register all Api handlers on the RPC server.
 * Implements the desktop RPC contract in the Agent Host process.
 */
/**
 * Register all Api handlers on the RPC server.
 * Implements the desktop RPC contract in the Agent Host process.
 */
import { modelCatalogHandlers } from "./handlers/model-catalog";
import { modelConfigHandlers } from "./handlers/models-config";
import { createAuthHandlers } from "./handlers/auth";
import { createFileHandlers } from "./handlers/files";
import { createWorktreeHandlers } from "./handlers/worktrees";
import { systemHandlers } from "./handlers/system";
import { createSessionHandlers } from "./handlers/sessions";
import { createTitleHandlers } from "./handlers/agent-title";
import { createAgentHandlers } from "./handlers/agent";
import { resourceHandlers } from "./handlers/resources";
import { createChannelHandlers, initializeChannels } from "./handlers/channels";
import { createHerdrHandlers } from "./handlers/herdr";
import { createProcessHandlers } from "./handlers/processes";
export { generateSessionTitleWithFallback, applySessionNameIfEmpty } from "./handlers/agent-title";
export { createAgentNewLockKey } from "./handlers/agent";
export { initializeChannels } from "./handlers/channels";
export { assertHerdrParamKeys } from "./handlers/herdr";

import { assertPathAllowed } from "./path-authorization";

export { projectModelsList } from "./handlers/model-catalog";
export { credentialMutationFailure } from "./handlers/auth";

import type { RpcServer } from "../contract/rpc";
import { RpcError } from "../contract/types";

import { disposeAllRpcSessions, subscribeRunningSessions, syncDesktopToolsForAllSessions } from "./rpc-manager";

import { createFileWatchService, stopAllFileWatches } from "./file-watch";
import { createAuthLoginService } from "./auth-login";
import { modelCatalogRefreshCoordinator } from "./model-runtime";

import { ChannelManager } from "./channels/channel-manager";

import { initializeManagedProcessService } from "./managed-process/runtime";
import { ManagedProcessError } from "./managed-process/service";

import { HerdrBridgeError } from "./herdr/errors";
import { clearHerdrBridge, initializeHerdrBridge } from "./herdr/runtime";

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

  const agentHandlers = createAgentHandlers({
    server,
    bindEvents: (session, id) => ensureSessionEvents(server, session, id),
  });
  const titleHandlers = createTitleHandlers(server);
  const channelHandlers = createChannelHandlers(channelManager);
  const processHandlers = createProcessHandlers(managedProcesses, managedCall);
  const herdrHandlers = createHerdrHandlers(herdr, herdrCall);

  server.handle({
    "host.ping": () => ({ ok: true as const, ts: Date.now() }),

    "herdr.runtime.get": herdrHandlers.runtimeGet,

    "herdr.runtime.configure": herdrHandlers.runtimeConfigure,

    "herdr.runtime.probe": herdrHandlers.runtimeProbe,

    "herdr.runtime.restart": herdrHandlers.runtimeRestart,

    "herdr.runtime.connect": herdrHandlers.runtimeConnect,

    "herdr.runtime.disconnect": herdrHandlers.runtimeDisconnect,

    "herdr.diagnostics": herdrHandlers.diagnostics,

    "herdr.snapshot": herdrHandlers.snapshot,

    "herdr.workspace.create": herdrHandlers.workspaceCreate,

    "herdr.pane.split": herdrHandlers.paneSplit,

    "herdr.pane.read": herdrHandlers.paneRead,

    "herdr.agent.start": herdrHandlers.agentStart,

    "herdr.agent.prompt": herdrHandlers.agentPrompt,

    "herdr.agent.sendKeys": herdrHandlers.agentSendKeys,

    "herdr.agent.wait": herdrHandlers.agentWait,

    "herdr.agent.waitCancel": herdrHandlers.agentWaitCancel,

    "herdr.terminal.open": herdrHandlers.terminalOpen,

    "herdr.terminal.input": herdrHandlers.terminalInput,

    "herdr.terminal.resize": herdrHandlers.terminalResize,

    "herdr.terminal.ack": herdrHandlers.terminalAck,

    "herdr.terminal.close": herdrHandlers.terminalClose,

    "host.toolchain": resourceHandlers.toolchain,

    "processes.list": processHandlers.list,

    "processes.get": processHandlers.get,

    "processes.read": processHandlers.read,

    "processes.wait": processHandlers.wait,

    "processes.write": processHandlers.write,

    "processes.stop": processHandlers.stop,

    "processes.stopAll": processHandlers.stopAll,

    "processes.restart": processHandlers.restart,

    "processes.dismiss": processHandlers.dismiss,

    "processes.export": processHandlers.export,

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

    "agent.new": agentHandlers.new,

    "agent.command": agentHandlers.command,

    "agent.state": agentHandlers.state,

    "agent.generateTitle": titleHandlers.generate,

    "channels.list": channelHandlers.list,

    "channels.accountUpsert": channelHandlers.accountUpsert,

    "channels.accountConnect": channelHandlers.accountConnect,

    "channels.accountDelete": channelHandlers.accountDelete,

    "channels.start": channelHandlers.start,

    "channels.stop": channelHandlers.stop,

    "channels.restart": channelHandlers.restart,

    "channels.probe": channelHandlers.probe,

    "channels.loginStart": channelHandlers.loginStart,

    "channels.loginWait": channelHandlers.loginWait,

    "channels.loginSubmitCode": channelHandlers.loginSubmitCode,

    "channels.loginCancel": channelHandlers.loginCancel,

    "channels.pairingApprove": channelHandlers.pairingApprove,

    "channels.pairingReject": channelHandlers.pairingReject,

    "channels.bindingUpsert": channelHandlers.bindingUpsert,

    "channels.bindingDelete": channelHandlers.bindingDelete,

    "channels.testSend": channelHandlers.testSend,

    "files.list": fileHandlers.list,

    "files.read": fileHandlers.read,

    "files.download": fileHandlers.download,

    "files.meta": fileHandlers.meta,

    "files.preview": fileHandlers.preview,

    "files.index": fileHandlers.index,

    "settings.getCacheWarming": resourceHandlers.getCacheWarming,

    "settings.setCacheWarming": resourceHandlers.setCacheWarming,

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

    "skills.list": resourceHandlers.listSkills,

    "skills.search": resourceHandlers.searchSkills,

    "skills.install": resourceHandlers.installSkill,

    "skills.set": resourceHandlers.setSkill,

    "skills.getContent": resourceHandlers.getSkillContent,

    "plugins.list": resourceHandlers.listPlugins,

    "plugins.set": resourceHandlers.setPlugin,

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
