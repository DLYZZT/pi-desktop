/**
 * Agent Host — utilityProcess entry.
 * Runs pi-coding-agent in-process; serves Api/Streams over MessagePort.
 */
import { createRpcServer } from "../contract/rpc";
import { registerHandlers } from "./handlers";
import { startSessionWatcher } from "./session-watcher";

const server = createRpcServer();
registerHandlers(server);
const stopWatcher = startSessionWatcher(server);

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
    const msg = event.data as { type?: string };
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
    if (msg?.type === "shutdown") {
      stopWatcher();
      process.exit(0);
    }
  });

  parentPort.postMessage({ type: "ready", ts: Date.now() });
  log("agent-host ready");
} else {
  // Fallback for non-electron (smoke / unit)
  console.log("[agent-host] no parentPort — standalone mode");
}

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  // Do not keep serving requests from a potentially corrupted Host. The main
  // process supervisor will restart this utility process within its budget.
  setImmediate(() => process.exit(1));
});
process.on("unhandledRejection", (err) => {
  log(`unhandledRejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  setImmediate(() => process.exit(1));
});

// Keep alive
setInterval(() => {}, 1 << 30);
