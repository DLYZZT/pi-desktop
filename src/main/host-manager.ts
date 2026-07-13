/**
 * Supervises the Agent Host utilityProcess.
 * Forwards MessagePorts between renderer and Host; restarts on crash.
 */
import { app, utilityProcess, MessageChannelMain, type UtilityProcess, type MessagePortMain } from "electron";
import fs from "fs";
import path from "path";
import { appendMainLog } from "./logger";

const CRASH_WINDOW_MS = 30_000;
const MAX_RESTARTS = 2;
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type HostMessage =
  | { type: "ready"; ts?: number }
  | { type: "pong"; ts?: number }
  | { type: "log"; message: string }
  | { type: "running-sessions"; sessionIds: string[] }
  | { type: "agent-end"; sessionId: string; eventType?: string }
  | { type: string; [key: string]: unknown };

export class HostManager {
  private child: UtilityProcess | null = null;
  private status: HostStatus = "stopped";
  private restartTimes: number[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private onStatusChange: ((s: HostStatus, detail?: string) => void) | null = null;
  private onHostMessage: ((msg: HostMessage) => void) | null = null;
  private pendingPorts: MessagePortMain[] = [];
  private wasReadyBeforeExit = false;
  private requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;

  constructor(private readonly hostEntry: string) {}

  setStatusListener(cb: (s: HostStatus, detail?: string) => void): void {
    this.onStatusChange = cb;
  }

  setMessageListener(cb: (msg: HostMessage) => void): void {
    this.onHostMessage = cb;
  }

  setRequestHandler(cb: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = cb;
  }

  getStatus(): HostStatus {
    return this.status;
  }

  start(): void {
    if (this.child) return;
    this.spawn();
  }

  stop(): void {
    this.clearPing();
    this.status = "stopped";
    if (this.child) {
      try {
        this.child.postMessage({ type: "shutdown" });
      } catch {
        try {
          this.child.kill();
        } catch {
          /* ignore */
        }
      }
      const child = this.child;
      setTimeout(() => {
        if (this.child !== child) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 1_500).unref();
    }
  }

  /** Hand a MessagePort to the Host so a renderer can talk to it directly. */
  attachRendererPort(port: MessagePortMain): void {
    if (!this.child || this.status !== "ready") {
      this.pendingPorts.push(port);
      // Still try — host may accept once ready
      if (this.child) {
        try {
          this.child.postMessage({ type: "attach-port" }, [port]);
          this.pendingPorts = this.pendingPorts.filter((p) => p !== port);
        } catch {
          /* keep pending */
        }
      }
      return;
    }
    try {
      this.child.postMessage({ type: "attach-port" }, [port]);
    } catch (err) {
      appendMainLog(`attachRendererPort failed: ${err}`);
    }
  }

  /** Create a MessageChannel and return the renderer-side port after Host attach. */
  createRendererChannel(): { port1: MessagePortMain; port2: MessagePortMain } {
    const { port1, port2 } = new MessageChannelMain();
    this.attachRendererPort(port2);
    return { port1, port2 };
  }

  /** Issue a one-shot RPC from the main process to the Host. */
  call<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.status !== "ready") {
      return Promise.reject(new Error("Agent Host is not ready"));
    }
    const { port1 } = this.createRendererChannel();
    const id = `main-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port1.close();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Host RPC timed out: ${method}`));
      }, timeoutMs);

      port1.on("message", (event) => {
        const message = event.data as {
          kind?: string;
          id?: string;
          ok?: boolean;
          result?: T;
          error?: { message?: string };
        };
        if (message.kind !== "response" || message.id !== id) return;
        cleanup();
        if (message.ok) resolve(message.result as T);
        else reject(new Error(message.error?.message ?? `Host RPC failed: ${method}`));
      });
      port1.start();
      port1.postMessage({ kind: "request", id, method, params });
    });
  }

  private setStatus(s: HostStatus, detail?: string): void {
    this.status = s;
    this.onStatusChange?.(s, detail);
  }

  private spawn(): void {
    appendMainLog(`spawning agent-host: ${this.hostEntry}`);
    this.setStatus("starting");

    // utilityProcess.fork rejects undefined env values
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    // Host must NOT run as pure node — it needs parentPort from utilityProcess
    delete env.ELECTRON_RUN_AS_NODE;
    env.PI_AGENT_HOST = "1";
    env.PI_DESKTOP_USER_DATA = app.getPath("userData");
    env.PI_DESKTOP_VERSION = app.getVersion();

    const child = utilityProcess.fork(this.hostEntry, [], {
      serviceName: "pi-agent-host",
      stdio: "pipe",
      env,
    });

    this.child = child;
    this.lastPong = Date.now();

    child.on("spawn", () => {
      appendMainLog("agent-host spawned");
      // Flush any pending ports
      for (const port of this.pendingPorts.splice(0)) {
        try {
          child.postMessage({ type: "attach-port" }, [port]);
        } catch (err) {
          appendMainLog(`flush pending port failed: ${err}`);
        }
      }
    });

    child.on("message", (msg: unknown) => {
      const m = msg as HostMessage;
      if (m?.type === "ready") {
        appendMainLog("agent-host ready");
        const restarted = this.wasReadyBeforeExit;
        this.wasReadyBeforeExit = false;
        this.setStatus("ready");
        this.startPing();
        if (restarted) {
          this.onHostMessage?.({ type: "host-restarted", reason: "crash-recovery" });
        }
      } else if (m?.type === "pong") {
        this.lastPong = Date.now();
      } else if (m?.type === "log") {
        appendMainLog(`[host] ${m.message}`);
      } else if (m?.type === "host-rpc") {
        const request = m as HostMessage & { id?: string; method?: string; params?: unknown };
        const id = String(request.id ?? "");
        const method = String(request.method ?? "");
        if (id && method) {
          void (async () => {
            try {
              if (!this.requestHandler) throw new Error("Main request handler is unavailable");
              const result = await this.requestHandler(method, request.params);
              try {
                child.postMessage({ type: "host-rpc-result", id, ok: true, result });
              } catch {
                /* child exited while the request was running */
              }
            } catch (error) {
              try {
                child.postMessage({
                  type: "host-rpc-result",
                  id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              } catch {
                /* child exited while the request was running */
              }
            }
          })();
        }
      }
      this.onHostMessage?.(m);
    });

    child.on("exit", (code) => {
      appendMainLog(`agent-host exit code=${code}`);
      this.clearPing();
      this.child = null;
      if (this.status === "stopped") return;

      this.wasReadyBeforeExit = this.status === "ready" || this.status === "starting";
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < CRASH_WINDOW_MS);
      if (this.restartTimes.length >= MAX_RESTARTS) {
        this.setStatus("crashed", `Host exited (code ${code}) and restart budget exhausted`);
        return;
      }
      this.restartTimes.push(now);
      appendMainLog(`restarting agent-host (attempt ${this.restartTimes.length}/${MAX_RESTARTS})`);
      this.setStatus("starting", `restarting after exit ${code}`);
      setTimeout(() => this.spawn(), 500);
    });

    child.stdout?.on("data", (buf: Buffer) => {
      const line = buf.toString().trim();
      if (line) appendMainLog(`[host:out] ${line}`);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString().trim();
      if (line) appendMainLog(`[host:err] ${line}`);
    });
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (!this.child) return;
      if (Date.now() - this.lastPong > PING_TIMEOUT_MS + PING_INTERVAL_MS) {
        appendMainLog("agent-host ping timeout — killing");
        try {
          this.child.kill();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        this.child.postMessage({ type: "ping" });
      } catch {
        /* ignore */
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export function resolveHostEntry(mainDirectory = __dirname): string {
  // ESM agent-host (pi packages are import-only)
  return path.join(mainDirectory, "agent-host.mjs");
}

export function resolvePreloadPath(mainDirectory = __dirname): string {
  return path.join(mainDirectory, "..", "preload", "preload.js");
}

export function resolveRendererEntry(isDev: boolean, mainDirectory = __dirname): string {
  // Explicit Vite URL (npm run dev sets this)
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  // Prefer built renderer whenever it exists (works for `npm start` after build)
  const builtIndex = path.join(mainDirectory, "..", "renderer", "index.html");
  if (fs.existsSync(builtIndex)) {
    return "app://bundle/index.html";
  }
  // Dev without prior build: expect Vite on 5173
  if (isDev) {
    return "http://localhost:5173";
  }
  return "app://bundle/index.html";
}

export function getUserDataPath(...parts: string[]): string {
  return path.join(app.getPath("userData"), ...parts);
}
