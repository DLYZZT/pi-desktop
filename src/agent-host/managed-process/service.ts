import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcServer } from "../../contract/rpc.ts";
import type {
  ManagedLoopbackEndpoint,
  ManagedProcessChangedEvent,
  ManagedProcessErrorCode,
  ManagedProcessExit,
  ManagedProcessKind,
  ManagedProcessLogStream,
  ManagedProcessLogWindow,
  ManagedProcessOutputEvent,
  ManagedProcessPublicInfo,
  ManagedProcessReadParams,
  ManagedProcessReadiness,
  ManagedProcessReaperRecord,
  ManagedProcessStartParams,
  ManagedProcessStartResult,
  ManagedProcessState,
  ManagedProcessStopMode,
  ManagedProcessStopSource,
  ManagedProcessWaitFor,
  ManagedProcessWaitParams,
  ManagedProcessWriteParams,
} from "../../contract/processes.ts";
import { isManagedProcessActiveState } from "../../contract/processes.ts";
import type { ToolExecutionContext } from "../../shared/toolchains/types.ts";
import {
  MANAGED_PROCESS_LIMITS,
  ManagedProcessPolicyError,
  extractManagedLoopbackEndpoints,
  managedProcessCommandHash,
  managedProcessCommandDisplay,
  managedProcessNetworkWarnings,
  normalizeManagedProcessLabel,
  normalizeManagedReadBytes,
  normalizeManagedWaitMs,
  relativeManagedProcessCwd,
  resolveManagedProcessCwd,
  validateManagedProcessCommand,
} from "../../shared/managed-process-policy.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import { callMain } from "../parent-rpc.ts";
import { getProcessStartFingerprint, terminatePosixProcessGroup, terminateProcessTree } from "../process-tree.ts";
import { toolchainRuntime, type ToolchainRuntime } from "../toolchain-runtime.ts";
import { ManagedProcessOutputBuffer, ManagedProcessOutputDecoder, parseManagedProcessCursor } from "./output-buffer.ts";
import type { ManagedProcessWorkerEvent, ManagedProcessWorkerRequest } from "./protocol.ts";

const OUTPUT_NOTIFY_MS = 100;
const START_RATE_WINDOW_MS = 60_000;
const START_RATE_LIMIT = 12;
const WORKER_START_TIMEOUT_MS = 10_000;
const STOP_TOTAL_TIMEOUT_MS = 8_500;
const HOST_INSTANCE_ID = randomUUID();

type Waiter = { resolve: () => void };
type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

type ManagedRecord = {
  processId: string;
  runId: string;
  generation: number;
  label: string;
  kind: ManagedProcessKind;
  state: ManagedProcessState;
  readiness: ManagedProcessReadiness;
  readinessSpec: ManagedProcessWaitFor;
  readinessMatched?: string;
  ownerSessionId: string;
  ownerCwd: string;
  cwd: string;
  command: string;
  activateUi: boolean;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  stdinOpen: boolean;
  endpoints: ManagedLoopbackEndpoint[];
  networkWarnings: string[];
  restartCount: number;
  exit?: ManagedProcessExit;
  output: ManagedProcessOutputBuffer;
  decoder: ManagedProcessOutputDecoder;
  worker?: ChildProcess;
  workerStarted?: Deferred;
  finish?: Deferred;
  stopSource?: ManagedProcessStopSource;
  userStopBarrier: boolean;
  waiters: Set<Waiter>;
  outputNotifyTimer?: ReturnType<typeof setTimeout>;
  reaper?: ManagedProcessReaperRecord;
  reaperRegistered: boolean;
  stdinWindow: Array<{ at: number; bytes: number }>;
  agentWaitActive: boolean;
};

export interface ManagedProcessServiceOptions {
  platform?: NodeJS.Platform;
  runtime?: ToolchainRuntime;
  spawnProcess?: typeof spawn;
  workerEntryPath?: string;
  workerExecArgv?: string[];
  parentCall?: typeof callMain;
  fingerprint?: typeof getProcessStartFingerprint;
  now?: () => number;
}

export class ManagedProcessError extends Error {
  readonly code: ManagedProcessErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ManagedProcessErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ManagedProcessError";
    this.code = code;
    this.details = details;
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  code: ManagedProcessErrorCode = "PROCESS_STOP_TIMEOUT",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ManagedProcessError(code, message)), timeoutMs);
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

function safeWorkerEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "managed-process-worker.mjs");
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

function terminalState(state: ManagedProcessState): boolean {
  return !isManagedProcessActiveState(state);
}

function toolchainError(error: unknown): ManagedProcessError {
  if (error instanceof ToolchainError) {
    const code =
      error.code === "TOOLCHAIN_PROJECT_UNTRUSTED" ? "PROCESS_PROJECT_UNTRUSTED" : "PROCESS_SHELL_UNAVAILABLE";
    return new ManagedProcessError(code, error.message);
  }
  if (error instanceof ManagedProcessPolicyError) return new ManagedProcessError(error.code, error.message);
  if (error instanceof ManagedProcessError) return error;
  return new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Could not start the managed process safely");
}

function boundedSystemMessage(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export class ManagedProcessService {
  private readonly server: Pick<RpcServer, "emit">;
  private readonly platform: NodeJS.Platform;
  private readonly runtime: ToolchainRuntime;
  private readonly spawnProcess: typeof spawn;
  private readonly workerEntryPath: string;
  private readonly workerExecArgv: string[];
  private readonly parentCall: typeof callMain;
  private readonly fingerprint: typeof getProcessStartFingerprint;
  private readonly now: () => number;
  private readonly records = new Map<string, ManagedRecord>();
  private readonly startTimes: number[] = [];
  private revision = 0;
  private shuttingDown = false;
  private containmentFailed = false;

  constructor(server: Pick<RpcServer, "emit">, options: ManagedProcessServiceOptions = {}) {
    this.server = server;
    this.platform = options.platform ?? process.platform;
    this.runtime = options.runtime ?? toolchainRuntime;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.workerEntryPath = options.workerEntryPath ?? safeWorkerEntryPath();
    this.workerExecArgv = [...(options.workerExecArgv ?? [])];
    this.parentCall = options.parentCall ?? callMain;
    this.fingerprint = options.fingerprint ?? getProcessStartFingerprint;
    this.now = options.now ?? Date.now;
  }

  getRevision(): number {
    return this.revision;
  }

  list(includeExited = false, ownerSessionId?: string): { revision: number; processes: ManagedProcessPublicInfo[] } {
    this.pruneExited();
    const processes = [...this.records.values()]
      .filter(
        (record) =>
          (!ownerSessionId || record.ownerSessionId === ownerSessionId) &&
          (includeExited || !terminalState(record.state)),
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => this.publicInfo(record));
    return { revision: this.revision, processes };
  }

  get(processId: string, ownerSessionId?: string): ManagedProcessPublicInfo {
    return this.publicInfo(this.requireRecord(processId, ownerSessionId));
  }

  async startForAgent(
    ownerSessionId: string,
    ownerCwd: string,
    trusted: boolean,
    params: ManagedProcessStartParams,
    signal?: AbortSignal,
  ): Promise<ManagedProcessStartResult> {
    this.assertStartNotCancelled(signal);
    if (this.shuttingDown)
      throw new ManagedProcessError("PROCESS_FEATURE_DISABLED", "Managed processes are shutting down");
    await this.assertStartEnabled();
    if (!trusted)
      throw new ManagedProcessError(
        "PROCESS_PROJECT_UNTRUSTED",
        "Project trust is required to start a managed process",
      );
    this.assertStartBudget(ownerSessionId);

    let command: string;
    let cwd: string;
    try {
      command = validateManagedProcessCommand(params.command);
    } catch (error) {
      if (error instanceof ManagedProcessPolicyError && error.code === "PROCESS_CONFIRMATION_REQUIRED") {
        const confirmation = await this.parentCall<{ confirmed?: boolean }>(
          "managedProcesses.confirmLanBind",
          { ownerSessionId, commandHash: managedProcessCommandHash(params.command) },
          65_000,
        );
        if (!confirmation.confirmed) throw toolchainError(error);
        command = validateManagedProcessCommand(params.command, true);
      } else {
        throw toolchainError(error);
      }
    }
    try {
      cwd = await resolveManagedProcessCwd(ownerCwd, params.cwd);
    } catch (error) {
      throw toolchainError(error);
    }
    this.assertStartNotCancelled(signal);

    const now = this.now();
    const processId = `proc-${randomUUID()}`;
    const runId = randomUUID();
    const record = this.createRecord({
      processId,
      runId,
      generation: 1,
      label: normalizeManagedProcessLabel(params.label, command),
      kind: params.kind ?? "server",
      ownerSessionId,
      ownerCwd,
      cwd,
      command,
      activateUi: params.activateUi === true,
      createdAt: now,
      readinessSpec: params.waitFor ?? { type: "none" },
    });
    this.records.set(processId, record);
    this.emitChanged(record, "created");

    const onAbort = () => {
      if (!record.worker || terminalState(record.state)) return;
      void this.stop(record.processId, record.runId, "graceful", "agent", record.ownerSessionId).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.startRun(record, trusted, signal);
      await this.observeInitialWindow(record);
      this.assertStartNotCancelled(signal);
      return this.startResult(record);
    } catch (error) {
      await this.cleanupFailedRun(record);
      if (!terminalState(record.state)) {
        record.state = "failed";
        record.exit = { code: null, reason: "error", finishedAt: this.now() };
        record.stoppedAt = this.now();
        this.append(record, "system", boundedSystemMessage(error instanceof Error ? error.message : String(error)));
        this.emitChanged(record, "exit");
      }
      throw toolchainError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  read(params: ManagedProcessReadParams, ownerSessionId?: string, renderer = false): ManagedProcessLogWindow {
    const record = this.requireRecord(params.processId, ownerSessionId);
    this.assertRun(record, params.runId, params.cursor);
    const maxBytes = normalizeManagedReadBytes(params.maxBytes, renderer);
    const result = record.output.read(params.cursor, maxBytes, params.streams);
    const records = result.gap
      ? [
          {
            seq: Math.max(0, (parseManagedProcessCursor(result.earliestCursor, record.runId) ?? 0) - 1),
            timestamp: this.now(),
            stream: "system" as const,
            text: `[system] ${result.gap.droppedBytes} bytes / ${result.gap.droppedRecords} records were dropped before this cursor.`,
            runId: record.runId,
          },
          ...result.records,
        ]
      : result.records;
    return {
      processId: record.processId,
      runId: record.runId,
      fromCursor: result.fromCursor,
      nextCursor: result.nextCursor,
      earliestCursor: result.earliestCursor,
      records,
      truncated: result.truncated,
      ...(result.gap ? { gap: result.gap } : {}),
      state: record.state,
      readiness: record.readiness,
      endpoints: record.endpoints.map((endpoint) => ({ ...endpoint })),
      ...(record.exit ? { exit: { ...record.exit } } : {}),
    };
  }

  async wait(
    params: ManagedProcessWaitParams,
    ownerSessionId?: string,
    renderer = false,
    signal?: AbortSignal,
  ): Promise<ManagedProcessLogWindow> {
    const record = this.requireRecord(params.processId, ownerSessionId);
    this.assertRun(record, params.runId, params.cursor);
    const contains = params.contains;
    if (contains !== undefined && (typeof contains !== "string" || [...contains].length > 256)) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "wait contains exceeds the 256 character limit");
    }
    const before = this.read(params, ownerSessionId, renderer);
    const initialMatch = contains ? before.records.find((item) => item.text.includes(contains))?.text : undefined;
    if (before.records.length > 0 || terminalState(record.state) || initialMatch) {
      return { ...before, ...(initialMatch ? { matched: initialMatch } : {}) };
    }
    if (!renderer && record.agentWaitActive) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "Only one Agent wait is allowed per managed process");
    }
    if (!renderer) record.agentWaitActive = true;

    const timeoutMs = normalizeManagedWaitMs(params.timeoutMs);
    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve };
        record.waiters.add(waiter);
        const onAbort = () => {
          clearTimeout(timer);
          record.waiters.delete(waiter);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("Managed process wait cancelled"));
        };
        const timer = setTimeout(() => {
          timedOut = true;
          record.waiters.delete(waiter);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, timeoutMs);
        timer.unref();
        waiter.resolve = () => {
          clearTimeout(timer);
          record.waiters.delete(waiter);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      if (!renderer) record.agentWaitActive = false;
    }
    const result = this.read(params, ownerSessionId, renderer);
    const matched = contains ? result.records.find((item) => item.text.includes(contains))?.text : undefined;
    return { ...result, ...(timedOut ? { timedOut: true } : {}), ...(matched ? { matched } : {}) };
  }

  write(params: ManagedProcessWriteParams, ownerSessionId?: string): { ok: true; runId: string } {
    const record = this.requireRecord(params.processId, ownerSessionId);
    this.assertRun(record, params.runId);
    if (record.state !== "running" && record.state !== "ready") {
      throw new ManagedProcessError("PROCESS_NOT_RUNNING", "Managed process is not running");
    }
    if (!record.stdinOpen || !record.worker?.connected) {
      throw new ManagedProcessError("PROCESS_STDIN_CLOSED", "Managed process stdin is closed");
    }
    if (typeof params.text !== "string" || Buffer.byteLength(params.text, "utf8") > MANAGED_PROCESS_LIMITS.stdinBytes) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "stdin write exceeds the 64 KiB limit");
    }
    this.assertStdinRate(record, Buffer.byteLength(params.text, "utf8"));
    const message: ManagedProcessWorkerRequest = {
      type: "stdin",
      text: params.text,
      appendNewline: params.appendNewline !== false,
      close: params.close === true,
    };
    record.worker.send(message);
    if (params.close) record.stdinOpen = false;
    this.emitChanged(record, "state");
    return { ok: true, runId: record.runId };
  }

  async stop(
    processId: string,
    runId: string,
    mode: ManagedProcessStopMode = "graceful",
    source: ManagedProcessStopSource = "user",
    ownerSessionId?: string,
  ): Promise<ManagedProcessPublicInfo> {
    const record = this.requireRecord(processId, ownerSessionId);
    this.assertRun(record, runId);
    if (terminalState(record.state)) return this.publicInfo(record);
    if (source === "user") record.userStopBarrier = true;
    record.stopSource = source;
    record.state = "stopping";
    this.append(record, "system", `Stop requested by ${source} (${mode})`);
    this.emitChanged(record, "state");
    if (!record.worker) {
      record.state = "killed";
      record.stoppedAt = this.now();
      record.stdinOpen = false;
      record.exit = { code: null, reason: "stopped", stoppedBy: source, finishedAt: this.now() };
      record.finish?.resolve();
      this.emitChanged(record, "exit");
      return this.publicInfo(record);
    }
    const message: ManagedProcessWorkerRequest = { type: "stop", mode, source };
    if (record.worker.connected) {
      try {
        record.worker.send(message);
      } catch {
        /* fall through to direct process-tree cleanup */
      }
    }
    try {
      await timeout(
        record.finish?.promise ?? Promise.resolve(),
        STOP_TOTAL_TIMEOUT_MS,
        "Managed process did not stop in time",
      );
    } catch (error) {
      if (record.worker) await terminateProcessTree(record.worker, 1_000);
      if (!terminalState(record.state)) {
        record.state = "killed";
        record.stoppedAt = this.now();
        record.exit = { code: null, reason: "stopped", stoppedBy: source, finishedAt: this.now() };
        this.emitChanged(record, "exit");
        record.finish?.resolve();
      }
      if (error instanceof ManagedProcessError && mode !== "force") {
        this.append(record, "system", "Graceful stop timed out; process tree was force terminated");
      }
    }
    return this.publicInfo(record);
  }

  async restart(
    processId: string,
    runId: string,
    source: "agent" | "user",
    ownerSessionId?: string,
    trusted = true,
  ): Promise<ManagedProcessPublicInfo> {
    const record = this.requireRecord(processId, ownerSessionId);
    this.assertRun(record, runId);
    if (source === "agent" && record.userStopBarrier) {
      throw new ManagedProcessError(
        "PROCESS_USER_STOPPED",
        "The user stopped this process; only a user restart can clear the barrier",
      );
    }
    if (!terminalState(record.state)) await this.stop(processId, runId, "graceful", source, ownerSessionId);
    this.assertRun(record, runId);
    if (source === "agent" && record.userStopBarrier) {
      throw new ManagedProcessError(
        "PROCESS_USER_STOPPED",
        "The user stopped this process; only a user restart can clear the barrier",
      );
    }
    if (source === "user") record.userStopBarrier = false;
    await this.assertStartEnabled();
    this.assertRun(record, runId);
    if (source === "agent" && record.userStopBarrier) {
      throw new ManagedProcessError(
        "PROCESS_USER_STOPPED",
        "The user stopped this process; only a user restart can clear the barrier",
      );
    }
    if (!trusted)
      throw new ManagedProcessError(
        "PROCESS_PROJECT_UNTRUSTED",
        "Project trust is required to restart a managed process",
      );

    record.generation += 1;
    record.restartCount += 1;
    record.runId = randomUUID();
    record.state = "restarting";
    record.readiness = record.readinessSpec.type === "none" ? "not-requested" : "pending";
    record.readinessMatched = undefined;
    record.startedAt = undefined;
    record.stoppedAt = undefined;
    record.exit = undefined;
    record.stdinOpen = true;
    record.endpoints = [];
    record.networkWarnings = managedProcessNetworkWarnings(record.command);
    record.output = new ManagedProcessOutputBuffer(record.runId);
    record.decoder = this.createDecoder(record);
    record.worker = undefined;
    record.workerStarted = undefined;
    record.finish = undefined;
    record.reaper = undefined;
    record.reaperRegistered = false;
    record.stopSource = undefined;
    record.stdinWindow = [];
    this.emitChanged(record, "state");
    try {
      await this.startRun(record, trusted);
      return this.publicInfo(record);
    } catch (error) {
      await this.cleanupFailedRun(record);
      if (!terminalState(record.state)) {
        record.state = "failed";
        record.exit = { code: null, reason: "error", finishedAt: this.now() };
        record.stoppedAt = this.now();
        this.append(record, "system", boundedSystemMessage(error instanceof Error ? error.message : String(error)));
        this.emitChanged(record, "exit");
      }
      throw toolchainError(error);
    }
  }

  dismiss(processId: string): { ok: true } {
    const record = this.requireRecord(processId);
    if (!terminalState(record.state))
      throw new ManagedProcessError("PROCESS_NOT_RUNNING", "Stop the process before dismissing it");
    if (record.outputNotifyTimer) clearTimeout(record.outputNotifyTimer);
    this.records.delete(processId);
    this.notifyMainCount();
    this.revision += 1;
    const event: ManagedProcessChangedEvent = {
      revision: this.revision,
      processId,
      runId: record.runId,
      reason: "dismissed",
    };
    this.server.emit("processes.changed", processId, event);
    return { ok: true };
  }

  async exportLogs(
    processId: string,
    runId: string,
    streams?: ManagedProcessLogStream[],
  ): Promise<{ saved: boolean; fileName?: string }> {
    const record = this.requireRecord(processId);
    this.assertRun(record, runId);
    const streamSet = streams?.length ? new Set(streams) : null;
    const content = record.output
      .allRecords()
      .filter((item) => !streamSet || streamSet.has(item.stream))
      .map((item) => `[${new Date(item.timestamp).toISOString()}] [${item.stream}] ${item.text}`)
      .join("\n");
    const suggestedName = `${record.label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "process"}.log`;
    try {
      const target = await this.parentCall<{ path?: string; fileName?: string }>(
        "managedProcesses.selectExportTarget",
        { suggestedName },
        65_000,
      );
      if (!target.path) return { saved: false };
      await writeFile(target.path, content ? `${content}\n` : "", { encoding: "utf8", mode: 0o600, flag: "w" });
      return { saved: true, fileName: target.fileName ?? path.basename(target.path) };
    } catch (error) {
      throw new ManagedProcessError("PROCESS_EXPORT_FAILED", "Could not export the managed process log", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  activeForSession(sessionId: string): ManagedProcessPublicInfo[] {
    return [...this.records.values()]
      .filter((record) => record.ownerSessionId === sessionId && isManagedProcessActiveState(record.state))
      .map((record) => this.publicInfo(record));
  }

  activeWithinCwd(cwd: string): ManagedProcessPublicInfo[] {
    const relativeTo = path.resolve(cwd);
    return [...this.records.values()]
      .filter((record) => {
        if (!isManagedProcessActiveState(record.state)) return false;
        const relative = path.relative(relativeTo, record.cwd);
        return (
          relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        );
      })
      .map((record) => this.publicInfo(record));
  }

  async stopAll(
    source: ManagedProcessStopSource = "host",
    mode: ManagedProcessStopMode = "graceful",
    permanent = source === "host",
  ): Promise<number> {
    if (permanent) this.shuttingDown = true;
    const active = [...this.records.values()].filter((record) => isManagedProcessActiveState(record.state));
    await Promise.allSettled(active.map((record) => this.stop(record.processId, record.runId, mode, source)));
    return active.length;
  }

  private createRecord(input: {
    processId: string;
    runId: string;
    generation: number;
    label: string;
    kind: ManagedProcessKind;
    ownerSessionId: string;
    ownerCwd: string;
    cwd: string;
    command: string;
    activateUi: boolean;
    createdAt: number;
    readinessSpec: ManagedProcessWaitFor;
  }): ManagedRecord {
    const record = {
      ...input,
      state: "created" as const,
      readiness: input.readinessSpec.type === "none" ? ("not-requested" as const) : ("pending" as const),
      stdinOpen: true,
      endpoints: [],
      networkWarnings: managedProcessNetworkWarnings(input.command),
      restartCount: 0,
      output: new ManagedProcessOutputBuffer(input.runId),
      decoder: undefined as unknown as ManagedProcessOutputDecoder,
      userStopBarrier: false,
      waiters: new Set<Waiter>(),
      reaperRegistered: false,
      stdinWindow: [],
      agentWaitActive: false,
    } satisfies ManagedRecord;
    record.decoder = this.createDecoder(record);
    return record;
  }

  private createDecoder(record: ManagedRecord): ManagedProcessOutputDecoder {
    return new ManagedProcessOutputDecoder((stream, line) => this.append(record, stream, line));
  }

  private async assertStartEnabled(): Promise<void> {
    if (this.containmentFailed) {
      throw new ManagedProcessError(
        "PROCESS_TREE_REAP_FAILED",
        "Managed process containment failed; restart the app after reviewing the Processes panel",
      );
    }
    if (this.platform === "win32") {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_UNSUPPORTED",
        "Managed processes are not available on Windows v1",
      );
    }
    if (this.platform !== "darwin" && this.platform !== "linux") {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_UNSUPPORTED",
        "Managed processes are not available on this platform",
      );
    }
    const setting = await this.parentCall<{ enabled?: boolean; reaperReady?: boolean }>(
      "managedProcesses.getSettings",
      undefined,
      5_000,
    );
    if (!setting.enabled)
      throw new ManagedProcessError("PROCESS_FEATURE_DISABLED", "Enable Managed Processes in Settings first");
    if (!setting.reaperReady) {
      throw new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process crash recovery is not ready");
    }
  }

  private assertStartBudget(ownerSessionId: string): void {
    const now = this.now();
    while (this.startTimes[0] !== undefined && now - this.startTimes[0] > START_RATE_WINDOW_MS) this.startTimes.shift();
    if (this.startTimes.length >= START_RATE_LIMIT) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "Managed process start rate limit reached");
    }
    const active = [...this.records.values()].filter((record) => isManagedProcessActiveState(record.state));
    if (active.length >= MANAGED_PROCESS_LIMITS.globalActive) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "Global managed process limit reached");
    }
    if (
      active.filter((record) => record.ownerSessionId === ownerSessionId).length >= MANAGED_PROCESS_LIMITS.sessionActive
    ) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "Session managed process limit reached");
    }
    this.startTimes.push(now);
  }

  private async startRun(record: ManagedRecord, trusted: boolean, signal?: AbortSignal): Promise<void> {
    record.state = "starting";
    record.finish = deferred();
    record.workerStarted = deferred();
    this.append(record, "system", `Starting ${record.label}`);
    this.emitChanged(record, "state");

    let context: ToolExecutionContext;
    try {
      context = await this.runtime.createExecutionContext({ cwd: record.cwd, intent: "managed-process", trusted });
      this.runtime.requireFromContext("shell.bash", context);
    } catch (error) {
      throw toolchainError(error);
    }
    this.assertStartNotCancelled(signal);
    if (record.stopSource !== undefined || terminalState(record.state)) {
      throw new ManagedProcessError("PROCESS_USER_STOPPED", "The managed process was stopped while starting");
    }
    const shell = this.runtime.requireFromContext("shell.bash", context);
    let worker: ChildProcess;
    try {
      worker = this.spawnProcess(process.execPath, [...this.workerExecArgv, this.workerEntryPath], {
        cwd: record.cwd,
        env: cleanEnvironment(context, record.processId, record.runId),
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      throw new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Could not start the managed process worker", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
    record.worker = worker;
    worker.stdout?.on("data", (chunk: Buffer | string) => record.decoder.write("stdout", chunk));
    worker.stderr?.on("data", (chunk: Buffer | string) => record.decoder.write("stderr", chunk));
    worker.stdout?.once("end", () => record.decoder.end("stdout"));
    worker.stderr?.once("end", () => record.decoder.end("stderr"));
    worker.on("message", (message: ManagedProcessWorkerEvent) => this.handleWorkerEvent(record, worker, message));
    worker.once("error", (error) => {
      if (record.worker !== worker) return;
      record.workerStarted?.reject(
        new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process worker failed to start"),
      );
      this.append(record, "system", boundedSystemMessage(error.message));
    });
    worker.once("close", (code, closeSignal) => {
      void this.handleWorkerClose(record, worker, code, closeSignal);
    });

    const bootstrap: ManagedProcessWorkerRequest = {
      type: "bootstrap",
      processId: record.processId,
      runId: record.runId,
      cwd: record.cwd,
      command: record.command,
      shell: {
        executable: shell.executable,
        argvPrefix: [...shell.argvPrefix],
        cwdSemantics: shell.cwdSemantics,
      },
    };
    worker.send(bootstrap);
    await timeout(
      record.workerStarted.promise,
      WORKER_START_TIMEOUT_MS,
      "Managed process worker did not start",
      "PROCESS_CONTAINMENT_UNAVAILABLE",
    );
    this.assertStartNotCancelled(signal);
    if (terminalState(record.state) || worker.exitCode !== null || worker.signalCode !== null) {
      await record.finish.promise;
      return;
    }
    if (!worker.pid)
      throw new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process worker has no PID");
    const startFingerprint = await this.fingerprint(worker.pid);
    if (!startFingerprint) {
      await terminateProcessTree(worker, 500);
      throw new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Could not verify managed process identity");
    }
    const reaper: ManagedProcessReaperRecord = {
      version: 1,
      processId: record.processId,
      runId: record.runId,
      hostInstanceId: HOST_INSTANCE_ID,
      pid: worker.pid,
      pgid: worker.pid,
      startFingerprint,
      nonce: randomUUID(),
      createdAt: this.now(),
    };
    record.reaper = reaper;
    try {
      await this.parentCall("managedProcesses.register", { record: reaper }, 5_000);
      record.reaperRegistered = true;
    } catch {
      await terminateProcessTree(worker, 500);
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Could not register managed process crash recovery",
      );
    }
    if (terminalState(record.state) || worker.exitCode !== null || worker.signalCode !== null) {
      await record.finish.promise;
      await this.unregisterReaper(record);
      return;
    }
    this.assertStartNotCancelled(signal);
    if (record.userStopBarrier) {
      await this.stop(record.processId, record.runId, "graceful", "user");
      throw new ManagedProcessError("PROCESS_USER_STOPPED", "The user stopped this process while it was starting");
    }
    if ((record.state as ManagedProcessState) !== "ready") record.state = "running";
    record.startedAt = this.now();
    this.emitChanged(record, "state");
  }

  private assertStartNotCancelled(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw new ManagedProcessError("PROCESS_USER_STOPPED", "Managed process start was cancelled");
  }

  private async cleanupFailedRun(record: ManagedRecord): Promise<void> {
    const worker = record.worker;
    if (!worker) {
      record.finish?.resolve();
      return;
    }
    try {
      await terminateProcessTree(worker, 1_000);
    } catch {
      this.containmentFailed = true;
    }
    if (!record.finish) return;
    try {
      await timeout(record.finish.promise, 2_500, "Managed process cleanup did not finish");
    } catch {
      this.containmentFailed = true;
      if (!terminalState(record.state)) {
        record.state = "lost";
        record.stoppedAt = this.now();
        record.exit = { code: null, reason: "host-failure", finishedAt: this.now() };
        this.append(record, "system", "Managed process cleanup could not be verified; new starts are disabled");
        this.emitChanged(record, "exit");
      }
    }
  }

  private async unregisterReaper(record: ManagedRecord): Promise<void> {
    if (!record.reaperRegistered || !record.reaper) return;
    const reaper = record.reaper;
    try {
      await this.parentCall(
        "managedProcesses.unregister",
        {
          hostInstanceId: reaper.hostInstanceId,
          processId: reaper.processId,
          runId: reaper.runId,
          nonce: reaper.nonce,
        },
        5_000,
      );
      if (record.reaper === reaper) record.reaperRegistered = false;
    } catch {
      this.containmentFailed = true;
      this.append(record, "system", "Crash-recovery cleanup could not be acknowledged; new starts are disabled");
      this.emitChanged(record, "state");
    }
  }

  private handleWorkerEvent(record: ManagedRecord, worker: ChildProcess, message: ManagedProcessWorkerEvent): void {
    if (record.worker !== worker || !message || typeof message !== "object") return;
    if (message.type === "started") {
      if (!Number.isSafeInteger(message.shellPid) || message.shellPid <= 1) {
        record.workerStarted?.reject(
          new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed shell PID is invalid"),
        );
      } else {
        record.workerStarted?.resolve();
      }
      return;
    }
    if (message.type === "stdin-closed") {
      record.stdinOpen = false;
      this.emitChanged(record, "state");
      return;
    }
    if (message.type === "stopping") {
      this.append(record, "system", `Stopping phase: ${message.phase}`);
      return;
    }
    if (message.type === "error") {
      this.append(record, "system", `${boundedSystemMessage(message.code)}: ${boundedSystemMessage(message.message)}`);
      if (record.state === "starting") {
        record.workerStarted?.reject(
          new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process worker reported an error"),
        );
      }
      return;
    }
    if (message.type === "exit") {
      const stopped = record.stopSource !== undefined || record.state === "stopping";
      record.state = stopped ? "killed" : message.code === 0 ? "exited" : "failed";
      record.stoppedAt = this.now();
      record.stdinOpen = false;
      record.exit = {
        code: message.code,
        ...(message.signal ? { signal: message.signal } : {}),
        reason: stopped ? "stopped" : "exit",
        ...(record.stopSource ? { stoppedBy: record.stopSource } : {}),
        finishedAt: this.now(),
      };
      this.emitChanged(record, "exit");
      this.resolveWaiters(record);
    }
  }

  private async handleWorkerClose(
    record: ManagedRecord,
    worker: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (record.worker !== worker) return;
    record.workerStarted?.reject(
      new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process worker exited during startup"),
    );
    if (!terminalState(record.state)) {
      const stopped = record.stopSource !== undefined || record.state === "stopping";
      record.state = stopped ? "killed" : code === 0 ? "exited" : "failed";
      record.stoppedAt = this.now();
      record.stdinOpen = false;
      record.exit = {
        code,
        ...(signal ? { signal } : {}),
        reason: stopped ? "stopped" : "error",
        ...(record.stopSource ? { stoppedBy: record.stopSource } : {}),
        finishedAt: this.now(),
      };
      this.emitChanged(record, "exit");
    }
    this.resolveWaiters(record);

    const processGroupId = record.reaper?.pgid ?? worker.pid;
    let treeClean = true;
    if ((this.platform === "darwin" || this.platform === "linux") && processGroupId) {
      try {
        treeClean = await terminatePosixProcessGroup(processGroupId, {
          interruptMs: 250,
          terminateMs: 750,
          forceMs: 1_000,
        });
      } catch {
        treeClean = false;
      }
    }
    if (treeClean) {
      await this.unregisterReaper(record);
    } else {
      this.containmentFailed = true;
      record.state = "lost";
      record.exit = {
        code,
        ...(signal ? { signal } : {}),
        reason: "host-failure",
        finishedAt: this.now(),
      };
      this.append(record, "system", "Managed process tree cleanup could not be verified; new starts are disabled");
      this.emitChanged(record, "exit");
    }
    record.finish?.resolve();
  }

  private append(record: ManagedRecord, stream: ManagedProcessLogStream, text: string): void {
    const item = record.output.append(stream, text, this.now());
    if (!item) return;
    if (stream === "stdout" || stream === "stderr") {
      this.mergeEndpoints(record, extractManagedLoopbackEndpoints(item.text, stream, record.runId, item.timestamp));
      record.networkWarnings = managedProcessNetworkWarnings(record.command, item.text);
      this.updateReadiness(record, item.text);
    }
    this.trimGlobalOutput();
    this.scheduleOutputEvent(record);
    this.resolveWaiters(record);
  }

  private mergeEndpoints(record: ManagedRecord, endpoints: ManagedLoopbackEndpoint[]): void {
    let changed = false;
    for (const endpoint of endpoints) {
      const existing = record.endpoints.find((candidate) => candidate.url === endpoint.url);
      if (existing) {
        existing.lastSeenAt = endpoint.lastSeenAt;
      } else if (record.endpoints.length < MANAGED_PROCESS_LIMITS.endpointCount) {
        record.endpoints.push(endpoint);
        changed = true;
      }
    }
    if (
      changed &&
      record.readinessSpec.type === "loopback-url" &&
      record.readiness !== "ready" &&
      (record.state === "starting" || record.state === "running")
    ) {
      record.readiness = "ready";
      record.readinessMatched = record.endpoints[0]?.url;
      record.state = "ready";
      this.emitChanged(record, "readiness");
    }
  }

  private updateReadiness(record: ManagedRecord, text: string): void {
    if (record.state !== "starting" && record.state !== "running") return;
    if (record.readinessSpec.type !== "output" || record.readiness === "ready") return;
    if (!text.includes(record.readinessSpec.contains)) return;
    record.readiness = "ready";
    record.readinessMatched = record.readinessSpec.contains;
    record.state = "ready";
    this.emitChanged(record, "readiness");
  }

  private async observeInitialWindow(record: ManagedRecord): Promise<void> {
    if (record.readinessSpec.type === "none") {
      if (record.output.allRecords().some((item) => item.stream === "stdout" || item.stream === "stderr")) return;
      await new Promise<void>((resolve) => {
        const waiter: Waiter = { resolve };
        record.waiters.add(waiter);
        const timer = setTimeout(() => {
          record.waiters.delete(waiter);
          resolve();
        }, MANAGED_PROCESS_LIMITS.startWaitDefaultMs);
        timer.unref();
        waiter.resolve = () => {
          if (
            !terminalState(record.state) &&
            !record.output.allRecords().some((item) => item.stream === "stdout" || item.stream === "stderr")
          ) {
            return;
          }
          clearTimeout(timer);
          record.waiters.delete(waiter);
          resolve();
        };
      });
      return;
    }
    const timeoutMs = normalizeManagedWaitMs(record.readinessSpec.timeoutMs, true);
    if (record.readiness === "ready" || terminalState(record.state)) return;
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve };
      record.waiters.add(waiter);
      const timer = setTimeout(() => {
        record.waiters.delete(waiter);
        resolve();
      }, timeoutMs);
      timer.unref();
      waiter.resolve = () => {
        if (record.readiness !== "ready" && !terminalState(record.state)) return;
        clearTimeout(timer);
        record.waiters.delete(waiter);
        resolve();
      };
    });
    if ((record.readiness as ManagedProcessReadiness) !== "ready" && !terminalState(record.state)) {
      record.readiness = "timed-out";
      this.emitChanged(record, "readiness");
    }
  }

  private startResult(record: ManagedRecord): ManagedProcessStartResult {
    const output = this.read({ processId: record.processId, runId: record.runId }, record.ownerSessionId, false);
    const state =
      record.state === "ready"
        ? "ready"
        : record.state === "failed"
          ? "failed"
          : record.state === "exited" || record.state === "killed" || record.state === "reaped"
            ? "exited"
            : record.state === "starting"
              ? "starting"
              : "running";
    return {
      process: this.publicInfo(record),
      runId: record.runId,
      state,
      output,
      readiness: { state: record.readiness, ...(record.readinessMatched ? { matched: record.readinessMatched } : {}) },
      endpoints: record.endpoints.map((endpoint) => ({ ...endpoint })),
    };
  }

  private publicInfo(record: ManagedRecord): ManagedProcessPublicInfo {
    const lastOutput = record.output.allRecords().at(-1);
    return {
      processId: record.processId,
      runId: record.runId,
      generation: record.generation,
      label: record.label,
      kind: record.kind,
      state: record.state,
      readiness: record.readiness,
      ownerSessionId: record.ownerSessionId,
      cwdDisplay: relativeManagedProcessCwd(record.ownerCwd, record.cwd),
      commandDisplay: managedProcessCommandDisplay(record.command),
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
      stdinOpen: record.stdinOpen,
      endpoints: record.endpoints.map((endpoint) => ({ ...endpoint })),
      networkWarnings: [...record.networkWarnings],
      restartCount: record.restartCount,
      ...(lastOutput
        ? { lastOutput: { stream: lastOutput.stream, text: lastOutput.text, timestamp: lastOutput.timestamp } }
        : {}),
      ...(record.exit ? { exit: { ...record.exit } } : {}),
      output: record.output.summary(),
    };
  }

  private requireRecord(processId: string, ownerSessionId?: string): ManagedRecord {
    if (typeof processId !== "string" || processId.length > 128) {
      throw new ManagedProcessError("PROCESS_NOT_FOUND", "Managed process not found");
    }
    const record = this.records.get(processId);
    if (!record || (ownerSessionId && record.ownerSessionId !== ownerSessionId)) {
      throw new ManagedProcessError("PROCESS_NOT_FOUND", "Managed process not found");
    }
    return record;
  }

  private assertRun(record: ManagedRecord, runId?: string, cursor?: string): void {
    if (runId && runId !== record.runId)
      throw new ManagedProcessError("PROCESS_STALE_RUN", "Managed process run has changed");
    if (cursor && parseManagedProcessCursor(cursor, record.runId) === null) {
      throw new ManagedProcessError("PROCESS_STALE_RUN", "Managed process cursor belongs to another run");
    }
  }

  private assertStdinRate(record: ManagedRecord, bytes: number): void {
    const now = this.now();
    record.stdinWindow = record.stdinWindow.filter((entry) => now - entry.at <= 60_000);
    const oneSecond = record.stdinWindow
      .filter((entry) => now - entry.at <= 1_000)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    const oneMinute = record.stdinWindow.reduce((sum, entry) => sum + entry.bytes, 0);
    if (oneSecond + bytes > 256 * 1024 || oneMinute + bytes > 1024 * 1024) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "Managed process stdin rate limit reached");
    }
    record.stdinWindow.push({ at: now, bytes });
  }

  private trimGlobalOutput(): void {
    let bytes = [...this.records.values()].reduce((sum, record) => sum + record.output.retainedBytes(), 0);
    while (bytes > MANAGED_PROCESS_LIMITS.globalBytes) {
      const candidates = [...this.records.values()].filter((record) => record.output.retainedBytes() > 0);
      if (!candidates.length) break;
      candidates.sort((left, right) => right.output.retainedBytes() - left.output.retainedBytes());
      const before = candidates[0].output.retainedBytes();
      if (!candidates[0].output.dropOldest()) break;
      bytes -= Math.max(0, before - candidates[0].output.retainedBytes());
    }
  }

  private scheduleOutputEvent(record: ManagedRecord): void {
    if (record.outputNotifyTimer) return;
    record.outputNotifyTimer = setTimeout(() => {
      record.outputNotifyTimer = undefined;
      this.revision += 1;
      const event: ManagedProcessOutputEvent = {
        revision: this.revision,
        processId: record.processId,
        runId: record.runId,
        latestCursor: record.output.summary().latestCursor,
      };
      this.server.emit("processes.output", record.processId, event);
    }, OUTPUT_NOTIFY_MS);
    record.outputNotifyTimer.unref();
  }

  private emitChanged(record: ManagedRecord, reason: ManagedProcessChangedEvent["reason"]): void {
    this.revision += 1;
    const event: ManagedProcessChangedEvent = {
      revision: this.revision,
      processId: record.processId,
      runId: record.runId,
      reason,
      ...(reason === "created" && record.activateUi ? { activateUi: true } : {}),
    };
    this.server.emit("processes.changed", record.processId, event);
    this.notifyMainCount();
    this.resolveWaiters(record);
  }

  private notifyMainCount(): void {
    const count = [...this.records.values()].filter((record) => isManagedProcessActiveState(record.state)).length;
    try {
      process.parentPort?.postMessage({ type: "managed-process-count", count });
    } catch {
      /* count is advisory; the Host registry remains authoritative */
    }
  }

  private resolveWaiters(record: ManagedRecord): void {
    for (const waiter of [...record.waiters]) waiter.resolve();
  }

  private pruneExited(): void {
    const now = this.now();
    const exited = [...this.records.values()]
      .filter((record) => terminalState(record.state))
      .sort((left, right) => (right.stoppedAt ?? right.createdAt) - (left.stoppedAt ?? left.createdAt));
    const remove = exited.filter(
      (record, index) =>
        index >= MANAGED_PROCESS_LIMITS.exitedRecords ||
        now - (record.stoppedAt ?? record.createdAt) > MANAGED_PROCESS_LIMITS.exitedRetentionMs,
    );
    for (const record of remove) {
      if (record.outputNotifyTimer) clearTimeout(record.outputNotifyTimer);
      this.records.delete(record.processId);
    }
  }
}
