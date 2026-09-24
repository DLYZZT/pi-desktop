import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { WindowsManagedProcessReaperRecord } from "../../contract/processes";
import type { WindowsManagedProcessHelperDescriptor } from "../../shared/windows-managed-process-helper";
import { callMain } from "../parent-rpc";
import { getManagedProcessOwnerIdentity } from "../managed-process/owner-identity";
import {
  WINDOWS_HELPER_KIND,
  WindowsHelperFrameDecoder,
  encodeWindowsHelperFrame,
  encodeWindowsHelperJson,
  parseWindowsHelperJson,
  type WindowsHelperFrame,
} from "../managed-process/helper-codec";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const INPUT_CHUNK_BYTES = 32 * 1024;

type HelperSettings = {
  reaperReady?: boolean;
  capability?: { backend?: string; ready?: boolean };
  windowsHelper?: WindowsManagedProcessHelperDescriptor;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), HANDSHAKE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

function terminalEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  const folded = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || key.toLowerCase() === "electron_run_as_node") continue;
    const normalized = key.toLowerCase();
    if (folded.has(normalized)) throw new Error("Duplicate Windows environment key");
    folded.add(normalized);
    environment[key] = value;
  }
  return environment;
}

export class WindowsHerdrTerminalChild extends EventEmitter {
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stderr = new PassThrough({ highWaterMark: 16 * 1024 });
  readonly stdin: Writable;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new WindowsHelperFrameDecoder();
  private readonly pending = new Map<number, WindowsHelperFrame[]>();
  private readonly waiters = new Map<number, ReturnType<typeof deferred<WindowsHelperFrame>>>();
  private sendSequence = 1;
  private reaper: WindowsManagedProcessReaperRecord | null = null;
  private cleanExit = false;
  private activeZero = false;
  private closed = false;
  private failed = false;
  private started = false;

  constructor(private readonly executable: string, private readonly args: string[], private readonly terminalId: string) {
    super();
    this.stdin = new Writable({
      highWaterMark: 256 * 1024,
      write: (chunk: Buffer, _encoding, callback) => {
        void this.writeInput(Buffer.from(chunk)).then(() => callback(), callback);
      },
    });
    this.stdout.on("drain", () => this.helper?.stdout.resume());
    this.stderr.on("drain", () => this.helper?.stdout.resume());
    queueMicrotask(() => void this.start().catch((error) => this.fail(error)));
  }

  private async start(): Promise<void> {
    const settings = await callMain<HelperSettings>("managedProcesses.getSettings", undefined, 5_000);
    const owner = getManagedProcessOwnerIdentity();
    const descriptor = settings.windowsHelper;
    if (!settings.reaperReady || settings.capability?.backend !== "windows-job" || !settings.capability.ready || !descriptor || !owner) {
      throw new Error("Windows terminal containment is unavailable");
    }
    const canonical = await realpath(descriptor.path);
    if (canonical !== descriptor.path || createHash("sha256").update(await readFile(canonical)).digest("hex") !== descriptor.sha256) {
      throw new Error("Windows terminal helper integrity check failed");
    }
    const nonce = randomBytes(32).toString("hex");
    const processId = `herdr-terminal-${this.terminalId}`;
    const runId = randomUUID();
    const jobName = `Local\\PiDesktop.Managed.${nonce}`;
    const bootstrap = {
      version: 1,
      processIdHash: createHash("sha256").update(processId).digest("hex"),
      runIdHash: createHash("sha256").update(runId).digest("hex"),
      jobName,
      nonce,
      cwd: path.dirname(this.executable),
      shellExecutable: this.executable,
      argvPrefix: this.args,
      command: "terminal",
      terminalMode: true,
      environment: terminalEnvironment(),
      mainPid: owner.mainPid,
      mainStartTimeMs: Number(owner.mainStartFingerprint),
      mainImagePath: owner.mainImagePath,
      hostPid: owner.hostPid,
      hostStartTimeMs: Number(owner.hostStartFingerprint),
      hostImagePath: owner.hostImagePath,
      hostInstanceId: owner.hostInstanceId,
    };
    const helper = spawn(descriptor.path, ["--owner-stdio-v1"], {
      cwd: path.dirname(descriptor.path), env: helperEnvironment(), shell: false,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.helper = helper;
    helper.stdout.on("data", (chunk: Buffer) => this.handleBytes(chunk));
    helper.stdin.on("error", (error) => this.fail(error));
    helper.stdout.on("error", (error) => this.fail(error));
    helper.stderr.on("data", (chunk: Buffer) => {
      // The native helper only emits bounded diagnostic codes on this stream.
      if (!this.stderr.write(chunk)) helper.stderr.pause();
    });
    this.stderr.on("drain", () => helper.stderr.resume());
    helper.once("error", (error) => this.fail(error));
    helper.once("close", (code) => void this.onHelperClose(code));
    const hello = parseWindowsHelperJson(await bounded(this.waitFor(WINDOWS_HELPER_KIND.hello), "Windows helper hello"));
    if (hello.protocolVersion !== 1 || hello.buildId !== descriptor.buildId || hello.provenance !== descriptor.provenance || hello.arch !== "x64" ||
        !Array.isArray(hello.capabilities) || hello.capabilities.join("\0") !== "job\0two-phase\0owner-watchdog\0reaper") {
      throw new Error("Windows helper hello mismatch");
    }
    this.sendJson(WINDOWS_HELPER_KIND.bootstrap, bootstrap);
    const prepared = parseWindowsHelperJson(await bounded(this.waitFor(WINDOWS_HELPER_KIND.prepared), "Windows helper prepare"));
    if (prepared.jobName !== jobName || prepared.nonce !== nonce || prepared.helperBuildId !== descriptor.buildId ||
        prepared.hostInstanceId !== owner.hostInstanceId || !Number.isSafeInteger(prepared.helperPid) ||
        typeof prepared.helperStartFingerprint !== "string") {
      throw new Error("Windows helper prepared identity mismatch");
    }
    this.pid = prepared.helperPid as number;
    const reaper: WindowsManagedProcessReaperRecord = {
      version: 2, platform: "win32", processId, runId, hostInstanceId: owner.hostInstanceId,
      helperPid: this.pid, helperStartFingerprint: prepared.helperStartFingerprint,
      jobName, helperBuildId: descriptor.buildId, nonce, createdAt: Date.now(),
    };
    const registered = await callMain<{ journalRevision?: number }>("managedProcesses.register", { record: reaper }, 5_000);
    if (!Number.isSafeInteger(registered.journalRevision) || (registered.journalRevision ?? 0) <= 0) {
      throw new Error("Windows terminal crash recovery registration failed");
    }
    this.reaper = reaper;
    this.sendJson(WINDOWS_HELPER_KIND.commit, { nonce, journalRevision: registered.journalRevision });
    const started = parseWindowsHelperJson(await bounded(this.waitFor(WINDOWS_HELPER_KIND.started), "Windows helper start"));
    if (started.hostInstanceId !== owner.hostInstanceId || started.journalRevision !== registered.journalRevision) {
      throw new Error("Windows helper started identity mismatch");
    }
    this.started = true;
    this.emit("spawn");
  }

  private waitFor(kind: number): Promise<WindowsHelperFrame> {
    const pending = this.pending.get(kind);
    if (pending?.length) return Promise.resolve(pending.shift()!);
    const waiter = deferred<WindowsHelperFrame>();
    this.waiters.set(kind, waiter);
    return waiter.promise;
  }

  private handleBytes(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind === WINDOWS_HELPER_KIND.hello || frame.kind === WINDOWS_HELPER_KIND.prepared || frame.kind === WINDOWS_HELPER_KIND.started) {
          const waiter = this.waiters.get(frame.kind);
          if (waiter) { this.waiters.delete(frame.kind); waiter.resolve(frame); }
          else this.pending.set(frame.kind, [frame]);
        } else if (frame.kind === WINDOWS_HELPER_KIND.stdout) {
          if (!this.stdout.write(frame.payload)) this.helper?.stdout.pause();
        } else if (frame.kind === WINDOWS_HELPER_KIND.stderr) {
          if (!this.stderr.write(frame.payload)) this.helper?.stdout.pause();
        } else if (frame.kind === WINDOWS_HELPER_KIND.activeZero) {
          this.activeZero = true;
        } else if (frame.kind === WINDOWS_HELPER_KIND.exit) {
          this.cleanExit = true;
        } else if (frame.kind === WINDOWS_HELPER_KIND.error || frame.kind === WINDOWS_HELPER_KIND.outputDropped) {
          throw new Error("Windows terminal helper reported a protocol or output failure");
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private async writeInput(bytes: Buffer): Promise<void> {
    if (!this.started || !this.helper?.stdin.writable) throw new Error("Windows terminal input is closed");
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const frame = encodeWindowsHelperFrame(WINDOWS_HELPER_KIND.stdin, this.sendSequence++, bytes.subarray(offset, offset + INPUT_CHUNK_BYTES));
      await new Promise<void>((resolve, reject) => {
        this.helper!.stdin.write(frame, (error) => error ? reject(error) : resolve());
      });
    }
  }

  private sendJson(kind: number, value: unknown): void {
    if (!this.helper?.stdin.writable) throw new Error("Windows terminal helper control pipe is closed");
    this.helper.stdin.write(encodeWindowsHelperJson(kind, this.sendSequence++, value));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.helper || this.closed) return false;
    this.stdout.resume();
    this.helper.stdout.resume();
    try {
      this.sendJson(WINDOWS_HELPER_KIND.stop, { mode: signal === "SIGKILL" ? "force" : "graceful", source: "host" });
      return true;
    } catch {
      this.helper.kill();
      return false;
    }
  }

  private fail(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    const failure = error instanceof Error ? error : new Error("Windows terminal helper failed");
    this.emit("error", failure);
    if (this.helper) this.helper.kill();
    else void this.onHelperClose(null);
  }

  private async onHelperClose(code: number | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    for (const waiter of this.waiters.values()) waiter.reject(new Error("Windows terminal helper exited"));
    this.waiters.clear();
    if (this.cleanExit && this.activeZero && this.reaper) {
      const reaper = this.reaper;
      try {
        await callMain("managedProcesses.unregister", {
          hostInstanceId: reaper.hostInstanceId, processId: reaper.processId,
          runId: reaper.runId, nonce: reaper.nonce,
        }, 5_000);
        this.reaper = null;
      } catch {
        // Keep the journal record for Main's crash reaper.
      }
    }
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}
