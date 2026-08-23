import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ToolExecutionContext } from "../../shared/toolchains/types.ts";
import { getProcessStartFingerprint, terminatePosixProcessGroup, terminateProcessTree } from "../process-tree.ts";
import type {
  ManagedProcessBackend,
  ManagedProcessBackendEvent,
  PreparedContainment,
  PreparedManagedProcessLaunch,
  StartedContainment,
} from "./backend.ts";
import type { ManagedProcessWorkerEvent, ManagedProcessWorkerRequest } from "./protocol.ts";

const WORKER_START_TIMEOUT_MS = 10_000;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function cleanEnvironment(context: ToolExecutionContext, processId: string, runId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(context.shellEnv)) {
    if (typeof value === "string") environment[key] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PI_DESKTOP_MANAGED_PROCESS = "1";
  environment.PI_DESKTOP_MANAGED_PROCESS_ID = processId;
  environment.PI_DESKTOP_MANAGED_RUN_ID = runId;
  return environment;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface PosixManagedProcessBackendOptions {
  platform: "darwin" | "linux";
  workerEntryPath: string;
  workerExecArgv?: readonly string[];
  hostInstanceId: string;
  spawnProcess?: typeof spawn;
  fingerprint?: typeof getProcessStartFingerprint;
  terminateProcessGroup?: typeof terminatePosixProcessGroup;
  now?: () => number;
}

export class PosixManagedProcessBackend implements ManagedProcessBackend {
  private readonly options: Required<
    Pick<PosixManagedProcessBackendOptions, "platform" | "workerEntryPath" | "hostInstanceId">
  > &
    Omit<PosixManagedProcessBackendOptions, "platform" | "workerEntryPath" | "hostInstanceId">;
  private readonly events = new EventEmitter();
  private readonly started = deferred();
  private readonly exited = deferred();
  private process?: ChildProcess;
  private prepared?: PreparedContainment;
  private targetExit?: { code: number | null; signal?: string };
  private stopRequested = false;
  private exitReported = false;

  constructor(options: PosixManagedProcessBackendOptions) {
    this.options = options;
  }

  get child(): ChildProcess | undefined {
    return this.process;
  }

  onEvent(listener: (event: ManagedProcessBackendEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async prepare(input: PreparedManagedProcessLaunch, signal?: AbortSignal): Promise<PreparedContainment> {
    if (this.process) throw new Error("POSIX managed process backend was already prepared");
    if (signal?.aborted) throw new Error("Managed process start was cancelled");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let worker: ChildProcess;
    try {
      worker = spawnProcess(process.execPath, [...(this.options.workerExecArgv ?? []), this.options.workerEntryPath], {
        cwd: input.cwd,
        env: cleanEnvironment(input.context, input.processId, input.runId),
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      throw new Error("Could not start the managed process worker", { cause: error });
    }
    this.process = worker;
    worker.stdout?.on("data", (chunk: Buffer | string) =>
      this.events.emit("event", {
        type: "stdout",
        bytes: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      } satisfies ManagedProcessBackendEvent),
    );
    worker.stderr?.on("data", (chunk: Buffer | string) =>
      this.events.emit("event", {
        type: "stderr",
        bytes: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      } satisfies ManagedProcessBackendEvent),
    );
    worker.on("message", (message: ManagedProcessWorkerEvent) => this.handleWorkerEvent(message));
    worker.once("error", (error) => {
      this.started.reject(new Error("Managed process worker failed to start"));
      this.events.emit("event", {
        type: "error",
        subcode: "WORKER_START_FAILED",
        message: error.message,
      } satisfies ManagedProcessBackendEvent);
    });
    worker.once("close", (code, closeSignal) => void this.handleWorkerClose(code, closeSignal));

    const bootstrap: ManagedProcessWorkerRequest = {
      type: "bootstrap",
      processId: input.processId,
      runId: input.runId,
      cwd: input.cwd,
      command: input.command,
      shell: input.shell,
    };
    worker.send(bootstrap);
    await withTimeout(this.started.promise, WORKER_START_TIMEOUT_MS, "Managed process worker did not start");
    if (signal?.aborted) {
      await this.dispose();
      throw new Error("Managed process start was cancelled");
    }
    if (!worker.pid) throw new Error("Managed process worker has no PID");
    const fingerprint = await (this.options.fingerprint ?? getProcessStartFingerprint)(worker.pid);
    if (!fingerprint) {
      await terminateProcessTree(worker, 500);
      throw new Error("Could not verify managed process identity");
    }
    const prepared: PreparedContainment = {
      reaper: {
        version: 2,
        platform: "posix",
        processId: input.processId,
        runId: input.runId,
        hostInstanceId: this.options.hostInstanceId,
        pid: worker.pid,
        pgid: worker.pid,
        startFingerprint: fingerprint,
        nonce: randomUUID(),
        createdAt: (this.options.now ?? Date.now)(),
      },
      privateState: { pid: worker.pid },
    };
    this.prepared = prepared;
    return prepared;
  }

  async commit(prepared: PreparedContainment, journalRevision: number): Promise<StartedContainment> {
    if (
      prepared !== this.prepared ||
      prepared.reaper.platform !== "posix" ||
      !Number.isSafeInteger(journalRevision) ||
      journalRevision <= 0
    ) {
      throw new Error("Invalid POSIX prepared containment");
    }
    return { started: true };
  }

  write(input: { text: string; appendNewline: boolean; close: boolean }): void {
    const worker = this.process;
    if (!worker?.connected) throw new Error("Managed process worker control pipe is closed");
    worker.send({ type: "stdin", ...input } satisfies ManagedProcessWorkerRequest);
  }

  async stop(mode: "graceful" | "force", source: "agent" | "user" | "host" | "main"): Promise<void> {
    const worker = this.process;
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    this.stopRequested = true;
    if (worker.connected) worker.send({ type: "stop", mode, source } satisfies ManagedProcessWorkerRequest);
  }

  waitForExit(): Promise<void> {
    return this.exited.promise;
  }

  async dispose(): Promise<void> {
    const worker = this.process;
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    this.stopRequested = true;
    await terminateProcessTree(worker, 1_000);
    await Promise.race([
      this.exited.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        timer.unref();
      }),
    ]);
  }

  private handleWorkerEvent(message: ManagedProcessWorkerEvent): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "started") {
      if (!Number.isSafeInteger(message.shellPid) || message.shellPid <= 1) {
        this.started.reject(new Error("Managed shell PID is invalid"));
      } else {
        this.started.resolve();
      }
      return;
    }
    if (message.type === "stdin-closed") {
      this.events.emit("event", { type: "stdin-closed" } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (message.type === "stopping") {
      this.events.emit("event", { type: "stopping", phase: message.phase } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (message.type === "error") {
      this.events.emit("event", {
        type: "error",
        subcode: message.code,
        message: message.message,
      } satisfies ManagedProcessBackendEvent);
      this.started.reject(new Error("Managed process worker reported an error"));
      return;
    }
    if (message.type === "exit")
      this.targetExit = { code: message.code, ...(message.signal ? { signal: message.signal } : {}) };
  }

  private async handleWorkerClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.started.reject(new Error("Managed process worker exited during startup"));
    const worker = this.process;
    const processGroupId = this.prepared?.reaper.platform === "posix" ? this.prepared.reaper.pgid : worker?.pid;
    let treeClean = true;
    if (processGroupId) {
      try {
        treeClean = await (this.options.terminateProcessGroup ?? terminatePosixProcessGroup)(processGroupId, {
          interruptMs: 250,
          terminateMs: 750,
          forceMs: 1_000,
        });
      } catch {
        treeClean = false;
      }
    }
    if (!this.exitReported) {
      this.exitReported = true;
      const target = this.targetExit ?? { code, ...(signal ? { signal } : {}) };
      this.events.emit("event", {
        type: "exit",
        exit: {
          ...target,
          reason: treeClean ? (this.stopRequested ? "stopped" : "exit") : "host-failure",
        },
      } satisfies ManagedProcessBackendEvent);
    }
    this.exited.resolve();
  }
}
