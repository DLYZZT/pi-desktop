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
import { probePiRuntimeModules } from "./pi-runtime-probe";
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

import type { RpcServer, RpcRequestContext } from "../contract/rpc";
import { createSessionEventBindings } from "./session-event-bindings";
import { createHostShutdown } from "./host-shutdown";
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
  const bindings = createSessionEventBindings(server);
  let closing = false;
  const fileWatch = createFileWatchService(server);
  const fileHandlers = createFileHandlers(fileWatch);
  const authLogin = createAuthLoginService(server);
  const authHandlers = createAuthHandlers(authLogin);
  const channelManager = new ChannelManager(server, (session, sessionId) => bindings.ensure(session, sessionId));
  initializeChannels(channelManager);
  const managedProcesses = initializeManagedProcessService(server);
  const worktreeHandlers = createWorktreeHandlers(managedProcesses);
  const sessionHandlers = createSessionHandlers({ server, managedProcesses, clearSessionEventBinding: bindings.clear });
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
  const stopRunning = subscribeRunningSessions((ids) => {
    if (closing) return;
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
    bindEvents: (session, id) => bindings.ensure(session, id),
  });
  const titleHandlers = createTitleHandlers(server);
  const channelHandlers = createChannelHandlers(channelManager);
  const processHandlers = createProcessHandlers(managedProcesses, managedCall);
  const herdrHandlers = createHerdrHandlers(herdr, herdrCall);

  const guard =
    <P, R>(handler: (params: P, context: RpcRequestContext) => R) =>
    (params: P, context: RpcRequestContext): R => {
      if (closing) throw new RpcError({ code: "CLOSED", message: "Agent Host is shutting down" });
      return handler(params, context);
    };

  server.handle({
    "host.ping": guard(() => ({ ok: true as const, ts: Date.now() })),
    "host.runtimeProbe": guard(probePiRuntimeModules),

    "herdr.runtime.get": guard(herdrHandlers.runtimeGet),

    "herdr.runtime.configure": guard(herdrHandlers.runtimeConfigure),

    "herdr.runtime.probe": guard(herdrHandlers.runtimeProbe),

    "herdr.runtime.restart": guard(herdrHandlers.runtimeRestart),

    "herdr.runtime.connect": guard(herdrHandlers.runtimeConnect),

    "herdr.runtime.disconnect": guard(herdrHandlers.runtimeDisconnect),

    "herdr.diagnostics": guard(herdrHandlers.diagnostics),

    "herdr.snapshot": guard(herdrHandlers.snapshot),

    "herdr.workspace.create": guard(herdrHandlers.workspaceCreate),

    "herdr.pane.split": guard(herdrHandlers.paneSplit),

    "herdr.pane.read": guard(herdrHandlers.paneRead),

    "herdr.agent.start": guard(herdrHandlers.agentStart),

    "herdr.agent.prompt": guard(herdrHandlers.agentPrompt),

    "herdr.agent.sendKeys": guard(herdrHandlers.agentSendKeys),

    "herdr.agent.wait": guard(herdrHandlers.agentWait),

    "herdr.agent.waitCancel": guard(herdrHandlers.agentWaitCancel),

    "herdr.terminal.open": guard(herdrHandlers.terminalOpen),

    "herdr.terminal.input": guard(herdrHandlers.terminalInput),

    "herdr.terminal.resize": guard(herdrHandlers.terminalResize),

    "herdr.terminal.ack": guard(herdrHandlers.terminalAck),

    "herdr.terminal.close": guard(herdrHandlers.terminalClose),

    "host.toolchain": guard(resourceHandlers.toolchain),

    "processes.list": guard(processHandlers.list),

    "processes.get": guard(processHandlers.get),

    "processes.read": guard(processHandlers.read),

    "processes.wait": guard(processHandlers.wait),

    "processes.write": guard(processHandlers.write),

    "processes.stop": guard(processHandlers.stop),

    "processes.stopAll": guard(processHandlers.stopAll),

    "processes.restart": guard(processHandlers.restart),

    "processes.dismiss": guard(processHandlers.dismiss),

    "processes.export": guard(processHandlers.export),

    "sessions.list": guard(sessionHandlers.list),

    "sessions.get": guard(sessionHandlers.get),

    "sessions.context": guard(sessionHandlers.context),

    "sessions.contextPage": guard(sessionHandlers.contextPage),

    "sessions.entryContent": guard(sessionHandlers.entryContent),

    "sessions.export": guard(sessionHandlers.export),

    "sessions.delete": guard(sessionHandlers.delete),

    "sessions.rename": guard(sessionHandlers.rename),

    "worktrees.list": guard(worktreeHandlers.list),

    "worktrees.create": guard(worktreeHandlers.create),

    "worktrees.remove": guard(worktreeHandlers.remove),

    "git.status": guard(worktreeHandlers.status),

    "agent.new": guard(agentHandlers.new),

    "agent.command": guard(agentHandlers.command),

    "agent.state": guard(agentHandlers.state),

    "agent.generateTitle": guard(titleHandlers.generate),

    "channels.list": guard(channelHandlers.list),

    "channels.accountUpsert": guard(channelHandlers.accountUpsert),

    "channels.accountConnect": guard(channelHandlers.accountConnect),

    "channels.accountDelete": guard(channelHandlers.accountDelete),

    "channels.start": guard(channelHandlers.start),

    "channels.stop": guard(channelHandlers.stop),

    "channels.restart": guard(channelHandlers.restart),

    "channels.probe": guard(channelHandlers.probe),

    "channels.loginStart": guard(channelHandlers.loginStart),

    "channels.loginWait": guard(channelHandlers.loginWait),

    "channels.loginSubmitCode": guard(channelHandlers.loginSubmitCode),

    "channels.loginCancel": guard(channelHandlers.loginCancel),

    "channels.pairingApprove": guard(channelHandlers.pairingApprove),

    "channels.pairingReject": guard(channelHandlers.pairingReject),

    "channels.bindingUpsert": guard(channelHandlers.bindingUpsert),

    "channels.bindingDelete": guard(channelHandlers.bindingDelete),

    "channels.testSend": guard(channelHandlers.testSend),

    "files.list": guard(fileHandlers.list),

    "files.read": guard(fileHandlers.read),

    "files.download": guard(fileHandlers.download),

    "files.meta": guard(fileHandlers.meta),

    "files.preview": guard(fileHandlers.preview),

    "files.index": guard(fileHandlers.index),

    "settings.getCacheWarming": guard(resourceHandlers.getCacheWarming),

    "settings.setCacheWarming": guard(resourceHandlers.setCacheWarming),

    "models.list": guard(modelCatalogHandlers.list),

    "models.refresh": guard(modelCatalogHandlers.refresh),

    "models.refreshCancel": guard(modelCatalogHandlers.cancelRefresh),

    "models.preferences.get": guard(modelCatalogHandlers.getPreferences),

    "models.preferences.set": guard(modelCatalogHandlers.setPreferences),

    "modelsConfig.get": guard(modelConfigHandlers.get),
    "modelsConfig.set": guard(modelConfigHandlers.set),
    "modelsConfig.test": guard(modelConfigHandlers.test),

    "auth.providers": guard(authHandlers.providers),

    "auth.allProviders": guard(authHandlers.allProviders),

    "auth.setApiKey": guard(authHandlers.setApiKey),

    "auth.deleteApiKey": guard(authHandlers.deleteApiKey),

    "auth.logout": guard(authHandlers.logout),

    "auth.loginSubmit": guard(authHandlers.submitLogin),

    "auth.loginStart": guard(authHandlers.startLogin),

    "auth.loginCancel": guard(authHandlers.cancelLogin),

    "skills.list": guard(resourceHandlers.listSkills),

    "skills.search": guard(resourceHandlers.searchSkills),

    "skills.install": guard(resourceHandlers.installSkill),

    "skills.set": guard(resourceHandlers.setSkill),

    "skills.getContent": guard(resourceHandlers.getSkillContent),

    "plugins.list": guard(resourceHandlers.listPlugins),

    "plugins.set": guard(resourceHandlers.setPlugin),

    "files.watchStart": guard(fileHandlers.startWatch),

    "files.watchStop": guard(fileHandlers.stopWatch),

    "system.home": guard(systemHandlers.home),

    "system.validateCwd": guard(systemHandlers.validateCwd),

    "system.defaultCwd": guard(systemHandlers.defaultCwd),

    "system.allowRoot": guard(systemHandlers.allowRoot),

    "system.runningCount": guard(systemHandlers.runningCount),
  });

  const shutdown = createHostShutdown([
    { name: "running subscription", stop: stopRunning },
    { name: "session event bindings", stop: bindings.close },
    { name: "authentication flows", stop: () => authLogin.dispose() },
    { name: "model refreshes", stop: () => modelCatalogRefreshCoordinator.cancelAll() },
    { name: "Herdr tool sync", stop: stopHerdrToolSync },
    { name: "Herdr", stop: () => herdr.shutdown() },
    { name: "Herdr registration", stop: () => clearHerdrBridge(herdr) },
    { name: "managed processes", stop: () => managedProcesses.stopAll("host") },
    { name: "channels", stop: () => channelManager.shutdown() },
    { name: "file watches", stop: stopAllFileWatches },
    { name: "Agent sessions", stop: disposeAllRpcSessions },
  ]);
  return () => {
    closing = true;
    return shutdown();
  };
}
