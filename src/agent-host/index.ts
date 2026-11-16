/**
 * Agent Host — utilityProcess entry.
 * Runs pi-coding-agent in-process; serves Api/Streams over MessagePort.
 */
import { createRpcServer } from "../contract/rpc";
import { registerHandlers } from "./handlers";
import { startSessionWatcher } from "./session-watcher";
import { RemoteControlController } from "./remote/controller.ts";
import type { RemoteControlConfig } from "../contract/desktop.ts";
import { toolchainRuntime } from "./toolchain-runtime";
import type { ToolchainSnapshot } from "../shared/toolchains/types";
import { installToolchainGitRunner } from "./toolchain-git";
import type { BrowserCapabilitySnapshot } from "../contract/browser";
import { browserCapabilityRuntime } from "./browser-capability-runtime";
import { getRpcSession, syncDesktopToolsForAllSessions } from "./rpc-manager";
import { readPiRuntimeVersion } from "./runtime-version";
import { applyManagedProcessOwnerIdentity } from "./managed-process/owner-identity";
import type { HerdrRuntimeDescriptor } from "../contract/herdr";
import { herdrRuntimeController } from "./herdr/runtime-controller";
import { initializeWebSearchRuntime } from "./web-search/runtime";

const piRuntimeVersion = readPiRuntimeVersion();

// Web search settings and credential state must exist before any session registers its tools.
initializeWebSearchRuntime();

const server = createRpcServer({
  // A renderer that (re)subscribes after a dialog was emitted would otherwise
  // wait out its timeout with no UI; replay the unresolved requests to it.
  onSubscribe: (topic, key, send) => {
    if (topic !== "agent.events") return;
    for (const event of getRpcSession(key)?.pendingUiEvents() ?? []) send(event);
  },
});
const restoreGitRunner = installToolchainGitRunner(toolchainRuntime, () => {
  // Emitted after the Host accepts the revision and invalidates its Git cache.
  // Chat histories are unchanged; only project metadata needs reconciliation.
  server.emit("sessions.changed", "*", { cwd: null, projectInfoChanged: true });
});

// Remote control plane: outbound-only gateway to the user-configured relay.
// Off by default; main pushes "remote:init"/"remote:changed" when the user
// toggles 自建托管 in settings. Created before registerHandlers because the
// remote.pair.* RPC methods delegate to it.
const remoteControl = new RemoteControlController({
  server,
  postStatus: (status) => {
    try {
      process.parentPort?.postMessage({ type: "remote-status", status });
    } catch {
      /* best-effort */
    }
  },
  log: (message) => log(`remote: ${message}`),
});

const stopHandlers = registerHandlers(server, { remoteControl });
const stopWatcher = startSessionWatcher(server);
process.parentPort?.postMessage({ type: "remote-config-request" });

function log(message: string): void {
  try {
    process.parentPort?.postMessage({ type: "log", message });
  } catch {
    console.log(`[agent-host] ${message}`);
  }
}

// Electron utilityProcess parent messaging
const parentPort = process.parentPort;
if (parentPort) {
  parentPort.on("message", (event) => {
    const msg = event.data as {
      type?: string;
      snapshot?: ToolchainSnapshot | BrowserCapabilitySnapshot;
      descriptor?: HerdrRuntimeDescriptor;
      config?: RemoteControlConfig;
      version?: unknown;
      mainPid?: unknown;
      mainStartFingerprint?: unknown;
      mainImagePath?: unknown;
      hostInstanceId?: unknown;
    };
    if (msg?.type === "ping") {
      parentPort.postMessage({ type: "pong", ts: Date.now() });
      return;
    }
    if (msg?.type === "attach-port") {
      const port = event.ports?.[0];
      if (port) {
        try {
          server.attachPort(port as never);
          log("renderer port attached");
        } catch (err) {
          log(`attach-port failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log("attach-port: no port in event");
      }
      return;
    }
    if (msg?.type === "managed-process-owner:init") {
      try {
        const owner = applyManagedProcessOwnerIdentity(msg);
        parentPort.postMessage({
          type: "managed-process-owner:ack",
          version: 1,
          hostInstanceId: owner.hostInstanceId,
        });
      } catch (error) {
        log(`managed process owner identity rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (msg?.type === "remote:init" || msg?.type === "remote:changed") {
      try {
        if (!msg.config) throw new Error("missing config");
        remoteControl.applyConfig(msg.config as RemoteControlConfig);
        log(`remote control ${msg.type === "remote:init" ? "initialized" : "updated"}`);
      } catch (error) {
        log(`remote config rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (msg?.type === "remote:reconnect") {
      remoteControl.reconnectNow();
      log("remote control reconnect requested");
      return;
    }
    if (msg?.type === "toolchain:init" || msg?.type === "toolchain:changed") {
      try {
        if (!msg.snapshot) throw new Error("missing snapshot");
        toolchainRuntime.apply(msg.snapshot as ToolchainSnapshot);
        parentPort.postMessage({ type: "toolchain:ack", revision: msg.snapshot.revision });
        log(`toolchain ${msg.type === "toolchain:init" ? "initialized" : "updated"} revision=${msg.snapshot.revision}`);
      } catch (error) {
        log(`toolchain snapshot rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (msg?.type === "browser:init" || msg?.type === "browser:changed") {
      try {
        if (!msg.snapshot) throw new Error("missing snapshot");
        browserCapabilityRuntime.apply(msg.snapshot as BrowserCapabilitySnapshot);
        syncDesktopToolsForAllSessions();
        parentPort.postMessage({ type: "browser:ack", revision: msg.snapshot.revision });
        log(`browser ${msg.type === "browser:init" ? "initialized" : "updated"} revision=${msg.snapshot.revision}`);
      } catch (error) {
        log(`browser capability snapshot rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (msg?.type === "herdr:runtime:init" || msg?.type === "herdr:runtime:changed") {
      try {
        if (!msg.descriptor) throw new Error("missing descriptor");
        herdrRuntimeController.apply(msg.descriptor);
        parentPort.postMessage({
          type: "herdr:ack",
          revision: msg.descriptor.revision,
          hostGeneration: msg.descriptor.hostGeneration,
        });
        log(
          `Herdr runtime ${msg.type === "herdr:runtime:init" ? "initialized" : "updated"} revision=${msg.descriptor.revision}`,
        );
      } catch (error) {
        log(`Herdr runtime descriptor rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (msg?.type === "shutdown") {
      stopWatcher();
      restoreGitRunner();
      void stopHandlers().then(
        () => process.exit(0),
        () => {
          log("Host handler cleanup failed");
          process.exit(1);
        },
      );
    }
  });

  parentPort.postMessage({ type: "ready", ts: Date.now(), piVersion: piRuntimeVersion });
  log("agent-host ready");
} else {
  // Fallback for non-electron (smoke / unit)
  console.log("[agent-host] no parentPort — standalone mode");
}

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  // Do not keep serving requests from a potentially corrupted Host. The main
  // process supervisor will restart this utility process within its budget.
  setImmediate(() => process.exit(1));
});
process.on("unhandledRejection", (err) => {
  log(`unhandledRejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  setImmediate(() => process.exit(1));
});

// Keep alive
setInterval(() => {}, 1 << 30);
