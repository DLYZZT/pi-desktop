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

export class HostManager {
  private child: UtilityProcess | null = null;
  private status: HostStatus = "stopped";
  private restartTimes: number[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private onStatusChange: ((s: HostStatus, detail?: string) => void) | null = null;
  private pendingPorts: MessagePortMain[] = [];

  constructor(private readonly hostEntry: string) {}

  setStatusListener(cb: (s: HostStatus, detail?: string) => void): void {
    this.onStatusChange = cb;
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
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
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
      const m = msg as { type?: string; [key: string]: unknown };
      if (m?.type === "ready") {
        appendMainLog("agent-host ready");
        this.setStatus("ready");
        this.startPing();
      } else if (m?.type === "pong") {
        this.lastPong = Date.now();
      } else if (m?.type === "log") {
        appendMainLog(`[host] ${m.message}`);
      }
    });

    child.on("exit", (code) => {
      appendMainLog(`agent-host exit code=${code}`);
      this.clearPing();
      this.child = null;
      if (this.status === "stopped") return;

      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < CRASH_WINDOW_MS);
      if (this.restartTimes.length >= MAX_RESTARTS) {
        this.setStatus("crashed", `Host exited (code ${code}) and restart budget exhausted`);
        return;
      }
      this.restartTimes.push(now);
      appendMainLog(`restarting agent-host (attempt ${this.restartTimes.length}/${MAX_RESTARTS})`);
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

export function resolveHostEntry(): string {
  // ESM agent-host (pi packages are import-only)
  return path.join(__dirname, "agent-host.mjs");
}

export function resolvePreloadPath(): string {
  return path.join(__dirname, "..", "preload", "preload.js");
}

export function resolveRendererEntry(isDev: boolean): string {
  // Explicit Vite URL (npm run dev sets this)
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  // Prefer built renderer whenever it exists (works for `npm start` after build)
  const builtIndex = path.join(__dirname, "..", "renderer", "index.html");
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
