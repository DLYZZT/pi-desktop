import { spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_ENDPOINT_POLL_MS = 50;
const DEFAULT_ENDPOINT_OWNERSHIP_GRACE_MS = 250;
const DEFAULT_STABLE_UPTIME_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 5;

export type HerdrManagedServerTarget = {
  executable: string;
  sessionName: string;
  endpoint: string;
};

export type HerdrManagedServerState = "stopped" | "starting" | "running" | "restarting" | "failed";

export type HerdrManagedServerFailure = "conflict" | "start-failed" | "restart-exhausted";

export type HerdrManagedServerEvent = {
  state: HerdrManagedServerState;
  target?: HerdrManagedServerTarget;
  failure?: HerdrManagedServerFailure;
};

type ChildLike = Pick<ChildProcess, "pid" | "once" | "kill">;

type ManagedServerOptions = {
  env?: NodeJS.ProcessEnv;
  envProvider?: () => NodeJS.ProcessEnv;
  spawn?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildLike;
  endpointReady?: (endpoint: string) => Promise<boolean>;
  endpointOccupied?: (endpoint: string) => Promise<boolean>;
  restartDelayMs?: (attempt: number) => number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  endpointPollMs?: number;
  endpointOwnershipGraceMs?: number;
  stableUptimeMs?: number;
  maxRestarts?: number;
  log?: (message: string) => void;
};

export class HerdrManagedServerError extends Error {
  constructor(
    readonly failure: HerdrManagedServerFailure,
    message: string,
  ) {
    super(message);
    this.name = "HerdrManagedServerError";
  }
}

function sameTarget(left: HerdrManagedServerTarget | null, right: HerdrManagedServerTarget): boolean {
  return (
    left?.executable === right.executable && left.sessionName === right.sessionName && left.endpoint === right.endpoint
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function safeSocketExists(endpoint: string): Promise<boolean> {
  try {
    const info = await lstat(endpoint);
    return (
      !info.isSymbolicLink() &&
      info.isSocket() &&
      (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

async function pathOccupied(endpoint: string): Promise<boolean> {
  try {
    await lstat(endpoint);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawn(executable: string, args: string[], env: NodeJS.ProcessEnv): ChildLike {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    env,
  });
}

export class HerdrManagedServerSupervisor {
  private readonly spawnServer: NonNullable<ManagedServerOptions["spawn"]>;
  private readonly endpointReady: NonNullable<ManagedServerOptions["endpointReady"]>;
  private readonly endpointOccupied: NonNullable<ManagedServerOptions["endpointOccupied"]>;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly forceStopTimeoutMs: number;
  private readonly endpointPollMs: number;
  private readonly endpointOwnershipGraceMs: number;
  private readonly stableUptimeMs: number;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: NonNullable<ManagedServerOptions["restartDelayMs"]>;
  private readonly log: (message: string) => void;
  private target: HerdrManagedServerTarget | null = null;
  private child: ChildLike | null = null;
  private state: HerdrManagedServerState = "stopped";
  private generation = 0;
  private restartAttempt = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: ((event: HerdrManagedServerEvent) => void) | null = null;

  constructor(private readonly options: ManagedServerOptions) {
    this.spawnServer = options.spawn ?? defaultSpawn;
    this.endpointReady = options.endpointReady ?? safeSocketExists;
    this.endpointOccupied = options.endpointOccupied ?? (options.endpointReady ? options.endpointReady : pathOccupied);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.forceStopTimeoutMs = options.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS;
    this.endpointPollMs = options.endpointPollMs ?? DEFAULT_ENDPOINT_POLL_MS;
    this.endpointOwnershipGraceMs = options.endpointOwnershipGraceMs ?? DEFAULT_ENDPOINT_OWNERSHIP_GRACE_MS;
    this.stableUptimeMs = options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.restartDelayMs = options.restartDelayMs ?? ((attempt) => Math.min(8_000, 500 * 2 ** attempt));
    this.log = options.log ?? (() => undefined);
  }

  setListener(listener: (event: HerdrManagedServerEvent) => void): void {
    this.listener = listener;
  }

  getState(): HerdrManagedServerState {
    return this.state;
  }

  getTarget(): HerdrManagedServerTarget | null {
    return this.target ? { ...this.target } : null;
  }

  async ensureRunning(target: HerdrManagedServerTarget): Promise<void> {
    if (sameTarget(this.target, target) && this.child && this.state === "running") return;
    if (this.target || this.child || this.restartTimer) await this.stop();
    if (await this.endpointOccupied(target.endpoint)) {
      this.target = { ...target };
      this.emit("failed", "conflict");
      throw new HerdrManagedServerError(
        "conflict",
        "The selected Herdr Session is already running outside Pi Desktop.",
      );
    }
    this.target = { ...target };
    this.restartAttempt = 0;
    const generation = ++this.generation;
    await this.startAttempt(generation, false);
  }

  async stop(): Promise<void> {
    const child = this.child;
    ++this.generation;
    this.target = null;
    this.clearTimers();
    if (!child) {
      this.emit("stopped");
      return;
    }

    // Only signal the exact foreground child handle that Pi Desktop spawned.
    // A separate `herdr server stop` command could target an unrelated server
    // if the Session endpoint were replaced during a restart race.
    this.signal(child, "SIGTERM");
    if (this.child === child && !(await this.waitForExit(child, this.stopTimeoutMs))) {
      this.signal(child, "SIGKILL");
      await this.waitForExit(child, this.forceStopTimeoutMs);
    }
    if (this.child === child) this.child = null;
    this.emit("stopped");
  }

  private async startAttempt(generation: number, restarting: boolean): Promise<void> {
    const target = this.target;
    if (!target || generation !== this.generation) return;
    if (await this.endpointOccupied(target.endpoint)) {
      if (generation !== this.generation || !sameTarget(this.target, target)) return;
      const error = new HerdrManagedServerError(
        "conflict",
        "The selected Herdr Session started outside Pi Desktop during managed restart.",
      );
      this.emit("failed", "conflict");
      throw error;
    }
    if (generation !== this.generation || !sameTarget(this.target, target)) return;
    this.emit(restarting ? "restarting" : "starting");

    let child: ChildLike;
    try {
      const env = { ...(this.options.envProvider?.() ?? this.options.env ?? process.env) };
      child = this.spawnServer(target.executable, ["--session", target.sessionName, "server"], env);
    } catch {
      const error = new HerdrManagedServerError("start-failed", "The managed Herdr server could not be started.");
      this.scheduleRestart(generation, error);
      throw error;
    }
    this.child = child;

    try {
      await this.waitForSpawnAndEndpoint(child, target, generation);
    } catch (error) {
      if (this.child === child) {
        this.signal(child, "SIGTERM");
        if (this.child === child && !(await this.waitForExit(child, this.stopTimeoutMs))) {
          this.signal(child, "SIGKILL");
          await this.waitForExit(child, this.forceStopTimeoutMs);
        }
        if (this.child === child) this.child = null;
        this.scheduleRestart(
          generation,
          error instanceof HerdrManagedServerError
            ? error
            : new HerdrManagedServerError("start-failed", "The managed Herdr server could not be started."),
        );
      }
      throw error;
    }

    if (this.child !== child || generation !== this.generation || !sameTarget(this.target, target)) return;
    this.startedAt = Date.now();
    this.emit("running");
    this.stabilityTimer = setTimeout(() => {
      if (this.child === child && generation === this.generation) this.restartAttempt = 0;
    }, this.stableUptimeMs);
    this.stabilityTimer.unref();
  }

  private waitForSpawnAndEndpoint(
    child: ChildLike,
    target: HerdrManagedServerTarget,
    generation: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let spawned = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const poll = async () => {
        while (!settled && spawned && this.child === child && generation === this.generation) {
          if (await this.endpointReady(target.endpoint)) {
            await new Promise<void>((resolve) => setTimeout(resolve, this.endpointOwnershipGraceMs));
            if (settled || this.child !== child || generation !== this.generation) return;
            if (await this.endpointReady(target.endpoint)) {
              finish();
              return;
            }
          }
          await delay(this.endpointPollMs);
        }
      };
      child.once("spawn", () => {
        spawned = true;
        void poll();
      });
      child.once("error", () => {
        const error = new HerdrManagedServerError("start-failed", "The managed Herdr server could not be started.");
        finish(error);
        this.handleUnexpectedExit(child, generation, error);
      });
      child.once("exit", (code, signal) => {
        const error = new HerdrManagedServerError(
          "start-failed",
          `The managed Herdr server exited (${code ?? signal ?? "unknown"}).`,
        );
        if (!settled) finish(error);
        this.handleUnexpectedExit(child, generation, error);
      });
      const timeout = setTimeout(() => {
        finish(new HerdrManagedServerError("start-failed", "The managed Herdr server did not become ready."));
      }, this.startupTimeoutMs);
      timeout.unref();
    });
  }

  private handleUnexpectedExit(child: ChildLike, generation: number, error: HerdrManagedServerError): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
    if (Date.now() - this.startedAt >= this.stableUptimeMs) this.restartAttempt = 0;
    this.scheduleRestart(generation, error);
  }

  private scheduleRestart(generation: number, error: HerdrManagedServerError): void {
    if (!this.target || generation !== this.generation || this.restartTimer) return;
    if (this.restartAttempt >= this.maxRestarts) {
      this.log(`managed Herdr server restart budget exhausted: ${error.failure}`);
      this.emit("failed", "restart-exhausted");
      return;
    }
    const attempt = this.restartAttempt++;
    const waitMs = this.restartDelayMs(attempt);
    this.emit("restarting", error.failure);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startAttempt(generation, true).catch(() => {
        // startAttempt schedules the next bounded retry.
      });
    }, waitMs);
    this.restartTimer.unref();
  }

  private waitForExit(child: ChildLike, timeoutMs: number): Promise<boolean> {
    if (this.child !== child) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      child.once("exit", () => finish(true));
      const timer = setTimeout(() => finish(this.child !== child), timeoutMs);
      timer.unref();
    });
  }

  private signal(child: ChildLike, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // The owned child already exited.
    }
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.restartTimer = null;
    this.stabilityTimer = null;
  }

  private emit(state: HerdrManagedServerState, failure?: HerdrManagedServerFailure): void {
    this.state = state;
    this.listener?.({
      state,
      ...(this.target ? { target: { ...this.target } } : {}),
      ...(failure ? { failure } : {}),
    });
  }
}
