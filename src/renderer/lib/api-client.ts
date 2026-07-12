/**
 * Transport facade — all renderer → Host communication goes through here.
 * Components call these helpers; they never touch MessagePort directly.
 */
import { createRpcClient, type PiRpc } from "@contract/rpc";
import type { ApiMethod, ApiParams, ApiResult, StreamTopic, Streams } from "@contract/api";

let rpc: PiRpc | null = null;
let connectPromise: Promise<PiRpc> | null = null;

/** Drop RPC client so the next ensureRpc() re-connects (Host crash recovery). */
export function resetRpc(): void {
  try {
    rpc?.close();
  } catch {
    /* ignore */
  }
  rpc = null;
  connectPromise = null;
}

const HOST_READY_TIMEOUT_MS = 30_000;
const PORT_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (timeout ${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Receive Host MessagePort transferred from preload via window.postMessage. */
function requestHostPort(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    if (!window.piBridge) {
      reject(new Error("piBridge not available — not running inside Electron?"));
      return;
    }

    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for host MessagePort"));
    }, PORT_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      // Only accept messages from our own window (preload → page)
      if (event.source !== window) return;
      const data = event.data as { channel?: string } | string | null;
      const isPortMsg =
        data === "pi-desktop-host-port" || (typeof data === "object" && data?.channel === "pi-desktop-host-port");
      if (!isPortMsg) return;
      const port = event.ports[0];
      if (!port) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(port);
    };

    window.addEventListener("message", onMessage);
    window.piBridge.requestHostPort();
  });
}

async function waitForHostReady(): Promise<void> {
  if (!window.piBridge) {
    throw new Error("piBridge not available — not running inside Electron?");
  }
  let status = await window.piBridge.getHostStatus();
  if (status === "ready") return;
  if (status === "crashed") {
    throw new Error("Agent Host crashed before UI connected");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Agent Host not ready (status=${status})`));
    }, HOST_READY_TIMEOUT_MS);

    const off = window.piBridge!.onHostStatus((s) => {
      status = s.status;
      if (s.status === "ready") {
        clearTimeout(timer);
        off();
        resolve();
      } else if (s.status === "crashed") {
        clearTimeout(timer);
        off();
        reject(new Error(s.detail || "Agent Host crashed"));
      }
    });

    // Race: status may flip ready between getHostStatus and subscribe
    void window.piBridge!.getHostStatus().then((s) => {
      if (s === "ready") {
        clearTimeout(timer);
        off();
        resolve();
      } else if (s === "crashed") {
        clearTimeout(timer);
        off();
        reject(new Error("Agent Host crashed"));
      }
    });
  });
}

export async function ensureRpc(): Promise<PiRpc> {
  if (rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (!window.piBridge) {
      throw new Error("piBridge not available — not running inside Electron?");
    }
    await waitForHostReady();
    const port = await requestHostPort();
    const client = createRpcClient(port);
    await withTimeout(client.call("host.ping"), PING_TIMEOUT_MS, "host.ping failed");
    rpc = client;
    return client;
  })();

  try {
    return await connectPromise;
  } catch (e) {
    connectPromise = null;
    rpc = null;
    throw e;
  }
}

export function getRpc(): PiRpc | null {
  return rpc;
}

export async function call<M extends ApiMethod>(
  method: M,
  ...args: ApiParams<M> extends void ? [] | [void] : [ApiParams<M>]
): Promise<ApiResult<M>> {
  const client = await ensureRpc();
  return client.call(method, ...(args as never));
}

export async function subscribe<T extends StreamTopic>(
  topic: T,
  key: string,
  on: (ev: Streams[T]) => void,
): Promise<() => void> {
  const client = await ensureRpc();
  return client.subscribe(topic, key, on);
}

// ---------------------------------------------------------------------------
// Convenience wrappers matching old HTTP routes
// ---------------------------------------------------------------------------

export async function listSessions() {
  return call("sessions.list");
}

export async function getSession(id: string, includeState?: boolean) {
  return call("sessions.get", { id, includeState });
}

export async function getSessionContext(id: string, leafId?: string) {
  return call("sessions.context", { id, leafId });
}

export async function exportSession(id: string, format: "md" | "json" = "md") {
  return call("sessions.export", { id, format });
}

export async function deleteSession(id: string) {
  return call("sessions.delete", { id });
}

export async function renameSession(id: string, name: string) {
  return call("sessions.rename", { id, name });
}

export async function newAgent(params: ApiParams<"agent.new">) {
  return call("agent.new", params);
}

export async function agentCommand(sessionId: string, command: Record<string, unknown>) {
  return call("agent.command", { sessionId, command: command as never });
}

export async function agentState(sessionId: string) {
  return call("agent.state", { sessionId });
}

export async function listModels(cwd?: string) {
  return call("models.list", cwd ? { cwd } : undefined);
}

export async function listWorktrees(projectRoot: string) {
  return call("worktrees.list", { projectRoot });
}

export async function validateCwd(path: string) {
  return call("system.validateCwd", { path });
}

export async function defaultCwd() {
  return call("system.defaultCwd");
}

export async function getHome() {
  return call("system.home");
}

export async function listFiles(path: string) {
  return call("files.list", { path });
}

export async function readFile(path: string, sourceSessionId?: string) {
  return call("files.read", { path, sourceSessionId });
}

export async function fileMeta(path: string, sourceSessionId?: string) {
  return call("files.meta", { path, sourceSessionId });
}

export async function fileIndex(root: string, query?: string) {
  return call("files.index", { root, query });
}

export async function subscribeAgentEvents(sessionId: string, on: (ev: Streams["agent.events"]) => void) {
  return subscribe("agent.events", sessionId, on);
}

export async function subscribeRunning(on: (ev: Streams["agent.running"]) => void) {
  return subscribe("agent.running", "*", on);
}

export async function subscribeSessionsChanged(on: (ev: Streams["sessions.changed"]) => void) {
  return subscribe("sessions.changed", "*", on);
}

export async function subscribeAuthLogin(provider: string, on: (ev: Streams["auth.login"]) => void) {
  return subscribe("auth.login", provider, on);
}
