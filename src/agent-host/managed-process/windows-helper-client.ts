import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ManagedProcessExit,
  ManagedProcessStopMode,
  ManagedProcessStopSource,
  WindowsManagedProcessReaperRecord,
} from "../../contract/processes.ts";
import type { WindowsManagedProcessHelperDescriptor } from "../../shared/windows-managed-process-helper.ts";
import { evaluateHeartbeatTick } from "../../shared/heartbeat-liveness.ts";
import type {
  ManagedProcessBackend,
  ManagedProcessBackendEvent,
  PreparedContainment,
  PreparedManagedProcessLaunch,
  StartedContainment,
} from "./backend.ts";
import {
  WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES,
  WINDOWS_HELPER_KIND,
  WindowsHelperFrameDecoder,
  encodeWindowsHelperJson,
  parseWindowsHelperJson,
  type WindowsHelperFrame,
} from "./helper-codec.ts";

const HELLO_TIMEOUT_MS = 2_000;
const PREPARE_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 2_000;
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
const SAFE_HELPER_SUBCODES = new Set([
  "HELPER_PROTOCOL_MISMATCH",
  "HELPER_INVALID_FRAME",
  "HELPER_BOOTSTRAP_TOO_LARGE",
  "HELPER_PARENT_UNAVAILABLE",
  "HELPER_PARENT_TIME_MISMATCH",
  "HELPER_PARENT_IMAGE_MISMATCH",
  "JOB_CREATE_FAILED",
  "JOB_LIMIT_FAILED",
  "JOB_COMPLETION_PORT_FAILED",
  "CONSOLE_SETUP_FAILED",
  "PIPE_SETUP_FAILED",
  "TARGET_CREATE_FAILED",
  "TARGET_ASSIGN_FAILED",
  "TARGET_RESUME_FAILED",
  "JOB_QUERY_FAILED",
  "JOB_TERMINATE_FAILED",
  "TARGET_COMMAND_LINE_TOO_LONG",
  "TARGET_ENVIRONMENT_TOO_LARGE",
  "HELPER_INTEGRITY_FAILED",
]);

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function normalizeEnvironment(
  environment: NodeJS.ProcessEnv,
  processId: string,
  runId: string,
): Record<string, string> {
  const folded = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || key.toLocaleLowerCase("en-US") === "electron_run_as_node") continue;
    const comparable = key.toLocaleLowerCase("en-US");
    if (folded.has(comparable)) throw new Error("Windows environment contains duplicate case-insensitive keys");
    folded.set(comparable, { key, value });
  }
  for (const [key, value] of [
    ["PI_DESKTOP_MANAGED_PROCESS", "1"],
    ["PI_DESKTOP_MANAGED_PROCESS_ID", processId],
    ["PI_DESKTOP_MANAGED_RUN_ID", runId],
  ]) {
    folded.set(key.toLocaleLowerCase("en-US"), { key, value });
  }
  if (folded.size > 4_096) throw new Error("Windows environment exceeds the 4096 entry limit");
  const entries = [...folded.values()].sort((left, right) =>
    left.key.localeCompare(right.key, "en-US", { sensitivity: "base" }),
  );
  let blockUnits = 1;
  const result: Record<string, string> = {};
  for (const { key, value } of entries) {
    if (!key || /[=\0]/u.test(key) || value.includes("\0")) throw new Error("Windows environment is invalid");
    const entryUnits = key.length + value.length + 2;
    if (entryUnits > 32_767) throw new Error("Windows environment entry is too large");
    blockUnits += entryUnits;
    result[key] = value;
  }
  if (blockUnits * 2 > 256 * 1024) throw new Error("Windows environment block exceeds 256 KiB");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 256 * 1024)
    throw new Error("Windows environment JSON exceeds 256 KiB");
  return result;
}

function safeHelperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR"]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export class WindowsJobProcessBackend implements ManagedProcessBackend {
  private readonly descriptor: WindowsManagedProcessHelperDescriptor;
  private readonly spawnProcess: typeof spawn;
  private process?: ChildProcess;
  private readonly events = new EventEmitter();
  private readonly decoder = new WindowsHelperFrameDecoder();
  private readonly waiters = new Map<number, Array<Deferred<WindowsHelperFrame>>>();
  private readonly pendingFrames = new Map<number, WindowsHelperFrame[]>();
  private readonly exited = deferred<void>();
  private sequence = 1;
  private exitReported = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingSequence = 0;
  private lastPongAt = Date.now();
  private lastPingTickAt = Date.now();

  constructor(descriptor: WindowsManagedProcessHelperDescriptor, spawnProcess: typeof spawn = spawn) {
    this.descriptor = descriptor;
    this.spawnProcess = spawnProcess;
  }

  get child(): ChildProcess | undefined {
    return this.process;
  }

  onEvent(listener: (event: ManagedProcessBackendEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async prepare(input: PreparedManagedProcessLaunch, signal?: AbortSignal): Promise<PreparedContainment> {
    if (this.process) throw new Error("Windows helper backend was already prepared");
    await this.verifyDescriptor();
    if (signal?.aborted) throw new Error("Windows helper start was cancelled");
    const owner = input.owner;
    if (!owner) throw new Error("Windows helper owner identity is unavailable");
    const environment = normalizeEnvironment(input.context.shellEnv, input.processId, input.runId);
    const nonce = randomBytes(32).toString("hex");
    const jobName = `Local\\PiDesktop.Managed.${nonce}`;
    const bootstrap = {
      version: 1,
      processIdHash: createHash("sha256").update(input.processId, "utf8").digest("hex"),
      runIdHash: createHash("sha256").update(input.runId, "utf8").digest("hex"),
      jobName,
      nonce,
      cwd: input.cwd,
      shellExecutable: input.shell.executable,
      argvPrefix: [...input.shell.argvPrefix],
      command: input.command,
      environment,
      mainPid: owner.mainPid,
      mainStartTimeMs: Number(owner.mainStartFingerprint),
      mainImagePath: owner.mainImagePath,
      hostPid: owner.hostPid,
      hostStartTimeMs: Number(owner.hostStartFingerprint),
      hostImagePath: owner.hostImagePath,
      hostInstanceId: owner.hostInstanceId,
    };
    const serialized = JSON.stringify(bootstrap);
    if (Buffer.byteLength(serialized, "utf8") > WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES)
      throw new Error("Windows helper bootstrap exceeds 512 KiB");
    const metadata = JSON.stringify({ ...bootstrap, command: "", environment: {} });
    if (Buffer.byteLength(metadata, "utf8") > 32 * 1024) throw new Error("Windows helper metadata exceeds 32 KiB");

    const helper = this.spawnProcess(this.descriptor.path, ["--owner-stdio-v1"], {
      cwd: path.dirname(this.descriptor.path),
      env: safeHelperEnvironment(),
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = helper;
    helper.stdin?.on("error", (error) => {
      const pipeError = error instanceof Error ? error : new Error("Windows helper control pipe failed");
      if (this.exitReported || helper.exitCode !== null || helper.signalCode !== null) {
        this.rejectWaiters(pipeError);
        return;
      }
      this.fail(pipeError);
    });
    let safeStderrBytes = 0;
    helper.stderr?.on("data", (chunk: Buffer) => {
      safeStderrBytes += chunk.length;
      if (safeStderrBytes > 4_096) this.fail(new Error("Windows helper stderr exceeded its diagnostic limit"));
    });
    helper.stdout?.on("data", (chunk: Buffer) => this.handleBytes(chunk));
    helper.stdout?.once("end", () => {
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Windows helper output was truncated"));
      }
    });
    helper.once("error", () => this.fail(new Error("Windows helper failed to start")));
    helper.once("close", (code) => {
      this.stopPing();
      if (!this.exitReported) {
        this.exitReported = true;
        this.events.emit("event", {
          type: "exit",
          exit: { code: null, reason: "host-failure" },
        } satisfies ManagedProcessBackendEvent);
      }
      this.rejectWaiters(new Error(`Windows helper exited with code ${code ?? "unknown"}`));
      this.exited.resolve();
    });
    const abort = () => void this.dispose();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const helloFrame = await withTimeout(
        this.waitForFrame(WINDOWS_HELPER_KIND.hello),
        HELLO_TIMEOUT_MS,
        "Windows helper hello timed out",
      );
      this.validateHello(parseWindowsHelperJson(helloFrame));
      this.send(WINDOWS_HELPER_KIND.bootstrap, serialized);
      const preparedFrame = await withTimeout(
        this.waitForFrame(WINDOWS_HELPER_KIND.prepared),
        PREPARE_TIMEOUT_MS,
        "Windows helper prepare timed out",
      );
      const prepared = this.validatePrepared(
        parseWindowsHelperJson(preparedFrame),
        owner.hostInstanceId,
        jobName,
        nonce,
      );
      const reaper: WindowsManagedProcessReaperRecord = {
        version: 2,
        platform: "win32",
        processId: input.processId,
        runId: input.runId,
        hostInstanceId: owner.hostInstanceId,
        helperPid: prepared.helperPid,
        helperStartFingerprint: prepared.helperStartFingerprint,
        jobName,
        helperBuildId: this.descriptor.buildId,
        nonce,
        createdAt: Date.now(),
      };
      return { reaper, privateState: { nonce, hostInstanceId: owner.hostInstanceId } };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async commit(prepared: PreparedContainment, journalRevision: number): Promise<StartedContainment> {
    if (prepared.reaper.platform !== "win32" || !prepared.privateState || typeof prepared.privateState !== "object")
      throw new Error("Invalid Windows prepared containment");
    const state = prepared.privateState as { nonce?: unknown; hostInstanceId?: unknown };
    if (typeof state.nonce !== "string" || typeof state.hostInstanceId !== "string")
      throw new Error("Invalid Windows prepared state");
    this.send(WINDOWS_HELPER_KIND.commit, JSON.stringify({ nonce: state.nonce, journalRevision }));
    const startedFrame = await withTimeout(
      this.waitForFrame(WINDOWS_HELPER_KIND.started),
      START_TIMEOUT_MS,
      "Windows helper commit timed out",
    );
    const started = parseWindowsHelperJson(startedFrame);
    if (
      !exactKeys(started, ["hostInstanceId", "journalRevision"]) ||
      started.hostInstanceId !== state.hostInstanceId ||
      started.journalRevision !== journalRevision
    ) {
      throw new Error("Windows helper started identity mismatch");
    }
    this.startPing();
    return { started: true };
  }

  write(input: { text: string; appendNewline: boolean; close: boolean }): void {
    this.send(WINDOWS_HELPER_KIND.stdin, JSON.stringify({ text: input.text, appendNewline: input.appendNewline }));
    if (input.close) this.send(WINDOWS_HELPER_KIND.closeStdin, "{}");
  }

  async stop(mode: ManagedProcessStopMode, source: ManagedProcessStopSource): Promise<void> {
    if (!this.process || this.process.exitCode !== null) return;
    this.send(WINDOWS_HELPER_KIND.stop, JSON.stringify({ mode, source }));
  }

  waitForExit(): Promise<void> {
    return this.exited.promise;
  }

  async dispose(): Promise<void> {
    this.stopPing();
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      this.send(WINDOWS_HELPER_KIND.shutdown, "{}");
    } catch {
      // The helper may already be exiting; killing the helper closes the Job.
    }
    await Promise.race([
      this.exited.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Process already exited.
          }
          resolve();
        }, 1_500);
        timer.unref();
      }),
    ]);
  }

  private async verifyDescriptor(): Promise<void> {
    const canonical = await realpath(this.descriptor.path);
    if (canonical !== this.descriptor.path) throw new Error("Windows helper path is not canonical");
    const bytes = await readFile(canonical);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== this.descriptor.sha256) throw new Error("Windows helper integrity check failed");
  }

  private send(kind: number, payload: string): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error("Windows helper control pipe is closed");
    const frame = encodeWindowsHelperJson(kind, this.sequence++, JSON.parse(payload));
    if (!stdin.write(frame)) {
      // Node continues draining the bounded write internally; callers remain
      // subject to the service's existing stdin rate limit.
    }
  }

  private waitForFrame(kind: number): Promise<WindowsHelperFrame> {
    const pending = this.pendingFrames.get(kind);
    if (pending?.length) {
      const frame = pending.shift()!;
      if (!pending.length) this.pendingFrames.delete(kind);
      return Promise.resolve(frame);
    }
    const waiter = deferred<WindowsHelperFrame>();
    const waiters = this.waiters.get(kind) ?? [];
    waiters.push(waiter);
    this.waiters.set(kind, waiters);
    return waiter.promise;
  }

  private handleBytes(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) this.handleFrame(frame);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Invalid Windows helper output"));
    }
  }

  private handleFrame(frame: WindowsHelperFrame): void {
    const waiting = this.waiters.get(frame.kind);
    if (waiting?.length) {
      waiting.shift()!.resolve(frame);
      if (!waiting.length) this.waiters.delete(frame.kind);
      return;
    }
    if (
      frame.kind === WINDOWS_HELPER_KIND.hello ||
      frame.kind === WINDOWS_HELPER_KIND.prepared ||
      frame.kind === WINDOWS_HELPER_KIND.started ||
      frame.kind === WINDOWS_HELPER_KIND.reapOutcome
    ) {
      const pending = this.pendingFrames.get(frame.kind) ?? [];
      if (pending.length >= 1) return this.fail(new Error("Duplicate Windows helper lifecycle event"));
      pending.push(frame);
      this.pendingFrames.set(frame.kind, pending);
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.stdout || frame.kind === WINDOWS_HELPER_KIND.stderr) {
      this.events.emit("event", {
        type: frame.kind === WINDOWS_HELPER_KIND.stdout ? "stdout" : "stderr",
        bytes: frame.payload,
      } satisfies ManagedProcessBackendEvent);
      return;
    }
    const value = parseWindowsHelperJson(frame);
    if (frame.kind === WINDOWS_HELPER_KIND.outputDropped) {
      if (
        !exactKeys(value, ["bytes", "chunks"]) ||
        !Number.isSafeInteger(value.bytes) ||
        (value.bytes as number) < 0 ||
        !Number.isSafeInteger(value.chunks) ||
        (value.chunks as number) < 0
      ) {
        return this.fail(new Error("Invalid Windows helper output drop event"));
      }
      this.events.emit("event", {
        type: "output-dropped",
        bytes: value.bytes as number,
        chunks: value.chunks as number,
      } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.stdinClosed) {
      if (!exactKeys(value, [])) return this.fail(new Error("Invalid Windows helper stdin event"));
      this.events.emit("event", { type: "stdin-closed" } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.stopping) {
      if (!exactKeys(value, ["phase"]) || !["interrupt", "terminate", "force"].includes(String(value.phase)))
        return this.fail(new Error("Invalid Windows helper stopping event"));
      this.events.emit("event", {
        type: "stopping",
        phase: value.phase as "interrupt" | "terminate" | "force",
      } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.activeZero) {
      if (!exactKeys(value, [])) return this.fail(new Error("Invalid Windows helper active-zero event"));
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.exit) {
      const exit = this.validateExit(value);
      this.exitReported = true;
      this.stopPing();
      this.events.emit("event", { type: "exit", exit } satisfies ManagedProcessBackendEvent);
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.error) {
      if (
        !exactKeys(value, ["subcode", "win32Code"]) ||
        typeof value.subcode !== "string" ||
        !SAFE_HELPER_SUBCODES.has(value.subcode) ||
        !Number.isSafeInteger(value.win32Code) ||
        (value.win32Code as number) < 0
      ) {
        return this.fail(new Error("Windows helper returned an unsafe error"));
      }
      this.events.emit("event", { type: "error", subcode: value.subcode } satisfies ManagedProcessBackendEvent);
      this.fail(new Error(value.subcode));
      return;
    }
    if (frame.kind === WINDOWS_HELPER_KIND.pong) {
      if (!exactKeys(value, ["sequence"]) || value.sequence !== this.pingSequence)
        return this.fail(new Error("Windows helper pong mismatch"));
      this.lastPongAt = Date.now();
      return;
    }
    this.fail(new Error("Unexpected Windows helper event"));
  }

  private validateHello(value: Record<string, unknown>): void {
    if (
      !exactKeys(value, ["protocolVersion", "buildId", "arch", "provenance", "capabilities"]) ||
      value.protocolVersion !== 1 ||
      value.buildId !== this.descriptor.buildId ||
      value.arch !== "x64" ||
      value.provenance !== this.descriptor.provenance ||
      !Array.isArray(value.capabilities) ||
      value.capabilities.join("\0") !== "job\0two-phase\0owner-watchdog\0reaper"
    ) {
      throw new Error("Windows helper hello mismatch");
    }
  }

  private validatePrepared(
    value: Record<string, unknown>,
    hostInstanceId: string,
    jobName: string,
    nonce: string,
  ): { helperPid: number; helperStartFingerprint: string } {
    if (
      !exactKeys(value, [
        "helperPid",
        "helperStartFingerprint",
        "jobName",
        "helperBuildId",
        "nonce",
        "hostInstanceId",
      ]) ||
      !Number.isSafeInteger(value.helperPid) ||
      (value.helperPid as number) <= 1 ||
      typeof value.helperStartFingerprint !== "string" ||
      value.helperStartFingerprint.length > 512 ||
      value.jobName !== jobName ||
      value.helperBuildId !== this.descriptor.buildId ||
      value.nonce !== nonce ||
      value.hostInstanceId !== hostInstanceId
    ) {
      throw new Error("Windows helper prepared identity mismatch");
    }
    return { helperPid: value.helperPid as number, helperStartFingerprint: value.helperStartFingerprint };
  }

  private validateExit(value: Record<string, unknown>): Omit<ManagedProcessExit, "finishedAt"> {
    const allowed = new Set(["code", "signal", "reason", "source"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Invalid Windows helper exit event");
    const code = value.code;
    if (code !== null && (!Number.isSafeInteger(code) || (code as number) < 0 || (code as number) > 0xffff_ffff))
      throw new Error("Invalid Windows helper exit code");
    if (!["exit", "stopped", "host-failure"].includes(String(value.reason)))
      throw new Error("Invalid Windows helper exit reason");
    const exit: Omit<ManagedProcessExit, "finishedAt"> = {
      code: code as number | null,
      reason: value.reason as "exit" | "stopped" | "host-failure",
    };
    if (
      typeof value.signal === "string" &&
      ["CTRL_C_EVENT", "CTRL_BREAK_EVENT", "JOB_TERMINATE"].includes(value.signal)
    )
      exit.signal = value.signal;
    if (typeof value.source === "string" && ["agent", "user", "host", "main"].includes(value.source))
      exit.stoppedBy = value.source as ManagedProcessStopSource;
    return exit;
  }

  private startPing(): void {
    const startedAt = Date.now();
    this.lastPongAt = startedAt;
    this.lastPingTickAt = startedAt;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const heartbeat = evaluateHeartbeatTick({
        now,
        lastTickAt: this.lastPingTickAt,
        lastAcknowledgedAt: this.lastPongAt,
        intervalMs: PING_INTERVAL_MS,
        timeoutMs: PING_TIMEOUT_MS,
      });
      this.lastPingTickAt = now;
      if (heartbeat.clockDiscontinuity) this.lastPongAt = now;
      if (heartbeat.timedOut) {
        this.fail(new Error("Windows helper heartbeat timed out"));
        return;
      }
      this.pingSequence += 1;
      try {
        this.send(WINDOWS_HELPER_KIND.ping, JSON.stringify({ sequence: this.pingSequence }));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Windows helper heartbeat failed"));
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private fail(error: Error): void {
    this.rejectWaiters(error);
    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
