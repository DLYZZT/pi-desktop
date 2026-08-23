import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcServer } from "../../contract/rpc.ts";
import type {
  ManagedLoopbackEndpoint,
  ManagedProcessChangedEvent,
  ManagedProcessCapability,
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
import type { CommandDescriptor, ToolExecutionContext } from "../../shared/toolchains/types.ts";
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
import { getProcessStartFingerprint, terminatePosixProcessGroup } from "../process-tree.ts";
import { toolchainRuntime, type ToolchainRuntime } from "../toolchain-runtime.ts";
import { ManagedProcessOutputBuffer, ManagedProcessOutputDecoder, parseManagedProcessCursor } from "./output-buffer.ts";
import type { ManagedProcessBackend, ManagedProcessBackendEvent } from "./backend.ts";
import { PosixManagedProcessBackend } from "./posix-backend.ts";
import { WindowsJobProcessBackend } from "./windows-helper-client.ts";
import type { WindowsManagedProcessHelperDescriptor } from "../../shared/windows-managed-process-helper.ts";
import { getManagedProcessOwnerIdentity } from "./owner-identity.ts";

const OUTPUT_NOTIFY_MS = 100;
const START_RATE_WINDOW_MS = 60_000;
const START_RATE_LIMIT = 12;
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
  backend?: ManagedProcessBackend;
  removeBackendListener?: () => void;
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
  terminateProcessGroup?: typeof terminatePosixProcessGroup;
  workerEntryPath?: string;
  workerExecArgv?: string[];
  parentCall?: typeof callMain;
  fingerprint?: typeof getProcessStartFingerprint;
  now?: () => number;
  arch?: NodeJS.Architecture;
  posixBackendFactory?: () => ManagedProcessBackend;
  windowsBackendFactory?: (descriptor: WindowsManagedProcessHelperDescriptor) => ManagedProcessBackend;
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
  private readonly arch: NodeJS.Architecture;
  private readonly runtime: ToolchainRuntime;
  private readonly parentCall: typeof callMain;
  private readonly now: () => number;
  private readonly posixBackendFactory: () => ManagedProcessBackend;
  private readonly windowsBackendFactory: (descriptor: WindowsManagedProcessHelperDescriptor) => ManagedProcessBackend;
  private readonly records = new Map<string, ManagedRecord>();
  private readonly startTimes: number[] = [];
  private revision = 0;
  private shuttingDown = false;
  private containmentFailed = false;
  private windowsHelper?: WindowsManagedProcessHelperDescriptor;

  constructor(server: Pick<RpcServer, "emit">, options: ManagedProcessServiceOptions = {}) {
    this.server = server;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.runtime = options.runtime ?? toolchainRuntime;
    this.parentCall = options.parentCall ?? callMain;
    this.now = options.now ?? Date.now;
    this.posixBackendFactory =
      options.posixBackendFactory ??
      (() => {
        if (this.platform !== "darwin" && this.platform !== "linux") {
          throw new Error("POSIX managed process backend is unavailable on this platform");
        }
        return new PosixManagedProcessBackend({
          platform: this.platform,
          workerEntryPath: options.workerEntryPath ?? safeWorkerEntryPath(),
          workerExecArgv: options.workerExecArgv,
          hostInstanceId: HOST_INSTANCE_ID,
          spawnProcess: options.spawnProcess ?? spawn,
          fingerprint: options.fingerprint ?? getProcessStartFingerprint,
          terminateProcessGroup: options.terminateProcessGroup ?? terminatePosixProcessGroup,
          now: this.now,
        });
      });
    this.windowsBackendFactory =
      options.windowsBackendFactory ?? ((descriptor) => new WindowsJobProcessBackend(descriptor));
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
      if (!record.backend || terminalState(record.state)) return;
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
    if (!record.stdinOpen || !record.backend) {
      throw new ManagedProcessError("PROCESS_STDIN_CLOSED", "Managed process stdin is closed");
    }
    if (typeof params.text !== "string" || Buffer.byteLength(params.text, "utf8") > MANAGED_PROCESS_LIMITS.stdinBytes) {
      throw new ManagedProcessError("PROCESS_LIMIT_REACHED", "stdin write exceeds the 64 KiB limit");
    }
    this.assertStdinRate(record, Buffer.byteLength(params.text, "utf8"));
    record.backend.write({
      text: params.text,
      appendNewline: params.appendNewline !== false,
      close: params.close === true,
    });
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
    if (!record.backend) {
      record.state = "killed";
      record.stoppedAt = this.now();
      record.stdinOpen = false;
      record.exit = { code: null, reason: "stopped", stoppedBy: source, finishedAt: this.now() };
      record.finish?.resolve();
      this.emitChanged(record, "exit");
      return this.publicInfo(record);
    }
    try {
      await record.backend.stop(mode, source);
    } catch {
      // The timeout cleanup below disposes the backend containment.
    }
    try {
      await timeout(
        record.finish?.promise ?? Promise.resolve(),
        STOP_TOTAL_TIMEOUT_MS,
        "Managed process did not stop in time",
      );
    } catch (error) {
      await record.backend.dispose();
      if (!terminalState(record.state)) {
        this.containmentFailed = true;
        record.state = "lost";
        record.stoppedAt = this.now();
        record.stdinOpen = false;
        record.exit = { code: null, reason: "host-failure", stoppedBy: source, finishedAt: this.now() };
        this.append(record, "system", "Managed process cleanup could not be verified; new starts are disabled");
        this.emitChanged(record, "exit");
        record.finish?.resolve();
      }
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
    record.removeBackendListener?.();
    record.backend = undefined;
    record.removeBackendListener = undefined;
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
    return new ManagedProcessOutputDecoder(
      (stream, line) => this.append(record, stream, line),
      () => this.append(record, "system", "Output may use a non-UTF-8 encoding; invalid bytes were replaced"),
    );
  }

  private async assertStartEnabled(): Promise<void> {
    if (this.containmentFailed) {
      throw new ManagedProcessError(
        "PROCESS_TREE_REAP_FAILED",
        "Managed process containment failed; restart the app after reviewing the Processes panel",
      );
    }
    if (this.platform === "win32" && this.arch !== "x64") {
      throw new ManagedProcessError("PROCESS_PLATFORM_UNSUPPORTED", "Managed processes require Windows x64");
    }
    if (this.platform !== "darwin" && this.platform !== "linux" && this.platform !== "win32") {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_UNSUPPORTED",
        "Managed processes are not available on this platform",
      );
    }
    const setting = await this.parentCall<{
      enabled?: boolean;
      reaperReady?: boolean;
      capability?: ManagedProcessCapability;
      windowsHelper?: WindowsManagedProcessHelperDescriptor;
    }>("managedProcesses.getSettings", undefined, 5_000);
    if (!setting.enabled)
      throw new ManagedProcessError(
        setting.capability?.supported === true && setting.capability.ready === false
          ? "PROCESS_CONTAINMENT_UNAVAILABLE"
          : "PROCESS_FEATURE_DISABLED",
        setting.capability?.ready === false
          ? "Managed process containment is not ready"
          : "Enable Managed Processes in Settings first",
        setting.capability?.errorCode ? { subcode: setting.capability.errorCode } : undefined,
      );
    if (!setting.reaperReady) {
      throw new ManagedProcessError("PROCESS_CONTAINMENT_UNAVAILABLE", "Managed process crash recovery is not ready");
    }
    if (this.platform === "win32") {
      if (
        setting.capability?.backend !== "windows-job" ||
        setting.capability.ready !== true ||
        !setting.windowsHelper ||
        !getManagedProcessOwnerIdentity()
      ) {
        throw new ManagedProcessError(
          "PROCESS_CONTAINMENT_UNAVAILABLE",
          "Windows managed process containment is not ready",
          { subcode: setting.capability?.errorCode ?? "OWNER_IDENTITY_UNAVAILABLE" },
        );
      }
      this.windowsHelper = setting.windowsHelper;
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
    if (this.platform === "win32") {
      await this.startWindowsRun(record, context, shell, signal);
      return;
    }
    await this.startPosixRun(record, context, shell, signal);
  }

  private async startPosixRun(
    record: ManagedRecord,
    context: ToolExecutionContext,
    shell: CommandDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const backend = this.posixBackendFactory();
    record.backend = backend;
    record.removeBackendListener = backend.onEvent((event) => this.handleBackendEvent(record, backend, event));
    let prepared: Awaited<ReturnType<ManagedProcessBackend["prepare"]>>;
    try {
      prepared = await backend.prepare(
        {
          processId: record.processId,
          runId: record.runId,
          cwd: record.cwd,
          command: record.command,
          shell: {
            executable: shell.executable,
            argvPrefix: [...shell.argvPrefix],
            cwdSemantics: shell.cwdSemantics,
          },
          context,
        },
        signal,
      );
    } catch (error) {
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "POSIX managed process worker could not prepare containment",
        { subcode: boundedSystemMessage(error instanceof Error ? error.message : "WORKER_START_FAILED") },
      );
    }
    record.reaper = prepared.reaper;
    let journalRevision: number;
    try {
      const registered = await this.parentCall<{ journalRevision?: number }>(
        "managedProcesses.register",
        { record: prepared.reaper },
        5_000,
      );
      if (!Number.isSafeInteger(registered.journalRevision) || (registered.journalRevision ?? 0) <= 0) {
        throw new Error("Invalid journal revision");
      }
      journalRevision = registered.journalRevision!;
      record.reaperRegistered = true;
    } catch {
      await backend.dispose();
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Could not register POSIX managed process crash recovery",
      );
    }
    try {
      await backend.commit(prepared, journalRevision);
    } catch (error) {
      await backend.dispose();
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "POSIX managed process worker could not commit containment",
        { subcode: boundedSystemMessage(error instanceof Error ? error.message : "WORKER_COMMIT_FAILED") },
      );
    }
    if (terminalState(record.state)) {
      await record.finish?.promise;
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

  private async startWindowsRun(
    record: ManagedRecord,
    context: ToolExecutionContext,
    shell: CommandDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const descriptor = this.windowsHelper;
    const owner = getManagedProcessOwnerIdentity();
    if (!descriptor || !owner) {
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Windows managed process owner identity is unavailable",
        { subcode: "OWNER_IDENTITY_UNAVAILABLE" },
      );
    }
    const backend = this.windowsBackendFactory(descriptor);
    record.backend = backend;
    record.removeBackendListener = backend.onEvent((event) => this.handleBackendEvent(record, backend, event));
    let prepared: Awaited<ReturnType<ManagedProcessBackend["prepare"]>>;
    try {
      prepared = await backend.prepare(
        {
          processId: record.processId,
          runId: record.runId,
          cwd: record.cwd,
          command: record.command,
          shell: {
            executable: shell.executable,
            argvPrefix: [...shell.argvPrefix],
            cwdSemantics: shell.cwdSemantics,
          },
          context,
          owner,
        },
        signal,
      );
    } catch (error) {
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Windows managed process helper could not prepare containment",
        { subcode: boundedSystemMessage(error instanceof Error ? error.message : "HELPER_INVALID_FRAME") },
      );
    }
    record.reaper = prepared.reaper;
    let journalRevision: number;
    try {
      const registered = await this.parentCall<{ journalRevision?: number }>(
        "managedProcesses.register",
        { record: prepared.reaper },
        5_000,
      );
      if (!Number.isSafeInteger(registered.journalRevision) || (registered.journalRevision ?? 0) <= 0)
        throw new Error("Invalid journal revision");
      journalRevision = registered.journalRevision!;
      record.reaperRegistered = true;
    } catch {
      await backend.dispose();
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Could not register Windows managed process crash recovery",
      );
    }
    try {
      await backend.commit(prepared, journalRevision);
    } catch (error) {
      await backend.dispose();
      throw new ManagedProcessError(
        "PROCESS_CONTAINMENT_UNAVAILABLE",
        "Windows managed process helper could not commit containment",
        { subcode: boundedSystemMessage(error instanceof Error ? error.message : "TARGET_RESUME_FAILED") },
      );
    }
    if (terminalState(record.state)) {
      await record.finish?.promise;
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
    if (record.backend) {
      try {
        await record.backend.dispose();
      } catch {
        this.containmentFailed = true;
      }
      if (!record.backend.child) {
        record.finish?.resolve();
        return;
      }
      try {
        await timeout(record.finish?.promise ?? Promise.resolve(), 2_500, "Managed process cleanup did not finish");
      } catch {
        this.containmentFailed = true;
      }
      return;
    }
    record.finish?.resolve();
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

  private handleBackendEvent(
    record: ManagedRecord,
    backend: ManagedProcessBackend,
    event: ManagedProcessBackendEvent,
  ): void {
    if (record.backend !== backend) return;
    if (event.type === "stdout" || event.type === "stderr") {
      record.decoder.write(event.type, event.bytes);
      return;
    }
    if (event.type === "output-dropped") {
      this.append(record, "system", `[system] Backend dropped ${event.bytes} bytes / ${event.chunks} chunks.`);
      return;
    }
    if (event.type === "stdin-closed") {
      record.stdinOpen = false;
      this.emitChanged(record, "state");
      return;
    }
    if (event.type === "stopping") {
      this.append(record, "system", `Stopping phase: ${event.phase}`);
      return;
    }
    if (event.type === "error") {
      const diagnostic = event.message
        ? `${boundedSystemMessage(event.subcode)}: ${boundedSystemMessage(event.message)}`
        : boundedSystemMessage(event.subcode);
      this.append(record, "system", diagnostic);
      return;
    }
    if (event.type === "exit") void this.finalizeBackendExit(record, backend, event.exit);
  }

  private async finalizeBackendExit(
    record: ManagedRecord,
    backend: ManagedProcessBackend,
    exit: Omit<ManagedProcessExit, "finishedAt">,
  ): Promise<void> {
    if (record.backend !== backend || terminalState(record.state)) return;
    record.decoder.end("stdout");
    record.decoder.end("stderr");
    const stopped = exit.reason === "stopped" || record.stopSource !== undefined || record.state === "stopping";
    record.state = stopped ? "killed" : exit.reason === "host-failure" ? "lost" : exit.code === 0 ? "exited" : "failed";
    record.stoppedAt = this.now();
    record.stdinOpen = false;
    record.exit = {
      ...exit,
      reason: stopped ? "stopped" : exit.reason,
      ...(record.stopSource ? { stoppedBy: record.stopSource } : {}),
      finishedAt: this.now(),
    };
    this.emitChanged(record, "exit");
    this.resolveWaiters(record);
    if (exit.reason === "host-failure") {
      this.containmentFailed = true;
      this.append(record, "system", "Managed process ownership was lost; new starts are disabled");
    } else {
      await this.unregisterReaper(record);
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
