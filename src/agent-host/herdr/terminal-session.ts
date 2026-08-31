import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RpcServer } from "../../contract/rpc";
import type { HerdrErrorCode, HerdrRuntimeDescriptor, HerdrTerminalStatus } from "../../contract/herdr";
import type { PosixManagedProcessReaperRecord } from "../../contract/processes";
import { callMain } from "../parent-rpc";
import { getProcessStartFingerprint } from "../process-tree";
import { getManagedProcessOwnerIdentity } from "../managed-process/owner-identity";
import { HerdrBridgeError } from "./errors";
import { isRecord } from "./protocol-v20";

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_BYTES_PER_SECOND = 256 * 1024;
const MAX_UNACKED_FRAMES = 32;
const MAX_UNACKED_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BUFFER_BYTES = MAX_UNACKED_FRAME_BYTES + MAX_LINE_BYTES;
const MAX_STDIN_BUFFER_BYTES = 256 * 1024;
const MAX_TERMINAL_SESSIONS = 8;
const RELEASE_DRAIN_MS = 100;
const TERMINATE_GRACE_MS = 2_000;

export type HerdrTerminalCrashRecovery = (
  child: ChildProcessWithoutNullStreams,
  terminalId: string,
) => Promise<() => Promise<void>>;

async function registerTerminalCrashRecovery(
  child: ChildProcessWithoutNullStreams,
  terminalId: string,
): Promise<() => Promise<void>> {
  // Windows needs the native Job helper so that stdio remains attached while
  // the controller is kill-on-close contained. Keep that platform fail-closed
  // at its own release gate; POSIX uses a detached process group today.
  if (process.platform === "win32") throw new Error("Herdr terminal containment is unavailable on Windows");
  const owner = getManagedProcessOwnerIdentity();
  const pid = child.pid;
  if (!owner || !pid) throw new Error("Herdr terminal owner identity is unavailable");
  const startFingerprint = await getProcessStartFingerprint(pid);
  if (!startFingerprint) throw new Error("Herdr terminal process identity could not be verified");
  const record: PosixManagedProcessReaperRecord = {
    version: 2,
    platform: "posix",
    processId: `herdr-terminal-${terminalId}`,
    runId: randomUUID(),
    hostInstanceId: owner.hostInstanceId,
    pid,
    pgid: pid,
    startFingerprint,
    nonce: randomUUID(),
    createdAt: Date.now(),
  };
  await callMain("managedProcesses.register", { record });
  return async () => {
    await callMain("managedProcesses.unregister", {
      hostInstanceId: record.hostInstanceId,
      processId: record.processId,
      runId: record.runId,
      nonce: record.nonce,
    });
  };
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000;
}

function strictBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  return Buffer.from(value, "base64");
}

export class HerdrTerminalSession {
  readonly terminalId = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private lastSeq = -1;
  private lastAck = -1;
  private schemaErrors = 0;
  private closed = false;
  private finalized = false;
  private paused = false;
  private readyForFrames = false;
  private readySettled = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private unregisterCrashRecovery?: () => Promise<void>;
  private unregisterStarted = false;
  private inputWindowStartedAt = Date.now();
  private inputWindowBytes = 0;
  private inputBackpressured = false;
  private blockedCommandBytes = 0;
  private pendingCommandBytes = 0;
  private readonly pendingCommands: Array<{ value: string; bytes: number }> = [];
  private readonly unackedFrameBytes = new Map<number, number>();
  private unackedBytes = 0;
  private terminateTimer: ReturnType<typeof setTimeout> | null = null;
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    private readonly server: RpcServer,
    private readonly descriptor: HerdrRuntimeDescriptor,
    readonly paneId: string,
    readonly mode: "observe" | "control",
    cols: number,
    rows: number,
    takeover: boolean,
    private readonly onClosed: (terminalId: string) => void,
    private readonly onFrame: (bytes: number) => void,
    private readonly onError: (code: HerdrErrorCode) => void,
    crashRecovery: HerdrTerminalCrashRecovery = registerTerminalCrashRecovery,
  ) {
    if (!descriptor.executable) throw new HerdrBridgeError("HERDR_BINARY_NOT_FOUND", "Herdr is unavailable.");
    if (!validDimension(cols) || !validDimension(rows)) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal dimensions must be between 1 and 1000.");
    }
    const args = [
      "--session",
      descriptor.sessionName,
      "terminal",
      "session",
      mode,
      paneId,
      "--cols",
      String(cols),
      "--rows",
      String(rows),
    ];
    if (mode === "control" && takeover) args.splice(6, 0, "--takeover");
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(descriptor.executable, args, {
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.emitStatus("opening");
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.readyForFrames) {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
          this.failReady(new Error("Herdr terminal frame exceeded 2 MiB before containment was ready."));
        }
        return;
      }
      this.consumeStdout(chunk);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Drain bounded-size process diagnostics without forwarding user/session data to Renderer.
      void chunk.subarray(Math.max(0, chunk.length - MAX_STDERR_BYTES));
    });
    this.child.stdin.on("error", () => {
      if (!this.closed) this.closeWithError("Herdr terminal input failed.");
    });
    this.child.stdin.on("drain", () => {
      this.inputBackpressured = false;
      this.blockedCommandBytes = 0;
      this.flushPendingCommands();
    });
    this.child.once("spawn", () => {
      void crashRecovery(this.child, this.terminalId)
        .then((unregister) => {
          this.unregisterCrashRecovery = unregister;
          if (this.closed) {
            this.failReady(new Error("Herdr terminal bridge closed before containment was ready."));
            if (this.child.exitCode !== null || this.child.signalCode !== null) this.unregisterAfterExit();
            return;
          }
          this.readyForFrames = true;
          this.succeedReady();
          this.emitStatus(mode === "control" ? "controlling" : "observing");
          this.consumeStdout(Buffer.alloc(0));
        })
        .catch((error) => this.failReady(error instanceof Error ? error : new Error(String(error))));
    });
    this.child.once("error", (error) => this.failReady(error));
    this.child.once("exit", (code, signal) => {
      this.unregisterAfterExit();
      if (this.closed) {
        this.failReady(new Error("Herdr terminal bridge closed before it was ready."));
        this.finalizeClosed();
        return;
      }
      if (!this.readySettled) {
        this.failReady(new Error(`Herdr terminal bridge exited with ${code ?? signal ?? "unknown"}.`));
      } else if (code === 0 || signal === "SIGTERM") this.finish("closed");
      else this.closeWithError(`Herdr terminal bridge exited with ${code ?? signal ?? "unknown"}.`);
    });
    this.child.once("close", () => {
      if (this.closed) this.finalizeClosed();
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  input(bytes: Uint8Array): void {
    if (this.mode !== "control") {
      throw new HerdrBridgeError("HERDR_TERMINAL_NOT_CONTROLLER", "This terminal is read-only.");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal input must be at most 64 KiB.");
    }
    const now = Date.now();
    if (now - this.inputWindowStartedAt >= 1_000) {
      this.inputWindowStartedAt = now;
      this.inputWindowBytes = 0;
    }
    if (this.inputWindowBytes + bytes.byteLength > MAX_INPUT_BYTES_PER_SECOND) {
      throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Terminal input rate exceeded 256 KiB/s.", true);
    }
    this.writeCommand({ type: "terminal.input", bytes: Buffer.from(bytes).toString("base64") });
    this.inputWindowBytes += bytes.byteLength;
  }

  resize(cols: number, rows: number): void {
    if (!validDimension(cols) || !validDimension(rows)) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal dimensions must be between 1 and 1000.");
    }
    if (this.mode === "control") this.writeCommand({ type: "terminal.resize", cols, rows });
  }

  ack(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < this.lastAck || seq > this.lastSeq) {
      throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Terminal frame acknowledgement is invalid.");
    }
    this.lastAck = seq;
    for (const [frameSeq, bytes] of this.unackedFrameBytes) {
      if (frameSeq > seq) continue;
      this.unackedFrameBytes.delete(frameSeq);
      this.unackedBytes -= bytes;
    }
    if (
      this.paused &&
      this.unackedFrameBytes.size < MAX_UNACKED_FRAMES / 2 &&
      this.unackedBytes < MAX_UNACKED_FRAME_BYTES / 2
    ) {
      this.paused = false;
      this.consumeStdout(Buffer.alloc(0));
      if (!this.paused && !this.closed) this.child.stdout.resume();
    }
  }

  close(release: boolean): Promise<void> {
    if (this.closed) return this.closedPromise;
    this.closed = true;
    this.discardPendingCommands();
    this.emitStatus("closed");
    this.terminate(release);
    return this.closedPromise;
  }

  private writeCommand(value: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new HerdrBridgeError("HERDR_TERMINAL_NOT_FOUND", "Terminal bridge is closed.", true);
    }
    const command = `${JSON.stringify(value)}\n`;
    const commandBytes = Buffer.byteLength(command);
    const bufferedBytes =
      Math.max(this.child.stdin.writableLength, this.blockedCommandBytes) + this.pendingCommandBytes;
    if (bufferedBytes + commandBytes > MAX_STDIN_BUFFER_BYTES) {
      throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "Terminal input is backpressured.", true);
    }
    if (this.inputBackpressured || this.pendingCommands.length > 0) {
      this.pendingCommands.push({ value: command, bytes: commandBytes });
      this.pendingCommandBytes += commandBytes;
      return;
    }
    if (!this.child.stdin.write(command)) {
      this.inputBackpressured = true;
      this.blockedCommandBytes = Math.max(commandBytes, this.child.stdin.writableLength);
    }
  }

  private flushPendingCommands(): void {
    if (this.closed || this.inputBackpressured || !this.child.stdin.writable) return;
    while (this.pendingCommands.length > 0 && !this.inputBackpressured && !this.closed) {
      const command = this.pendingCommands.shift()!;
      this.pendingCommandBytes -= command.bytes;
      try {
        if (!this.child.stdin.write(command.value)) {
          this.inputBackpressured = true;
          this.blockedCommandBytes = Math.max(command.bytes, this.child.stdin.writableLength);
        }
      } catch {
        this.closeWithError("Herdr terminal input failed.");
      }
    }
  }

  private discardPendingCommands(): void {
    this.pendingCommands.length = 0;
    this.pendingCommandBytes = 0;
  }

  private succeedReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private failReady(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    this.closeWithError(error.message);
  }

  private unregisterAfterExit(): void {
    if (this.unregisterStarted || !this.unregisterCrashRecovery) return;
    this.unregisterStarted = true;
    void this.unregisterCrashRecovery().catch(() => undefined);
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      this.closeWithError("Herdr terminal output exceeded the buffered byte limit.");
      return;
    }
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && this.stdoutBuffer.indexOf(0x0a) === -1) {
      this.closeWithError("Herdr terminal frame exceeded 2 MiB.");
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > MAX_LINE_BYTES) {
        this.closeWithError("Herdr terminal frame exceeded 2 MiB.");
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8");
      if (!this.consumeLine(line)) return;
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (this.closed || this.paused) return;
    }
  }

  private consumeLine(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.schemaFailure();
      return true;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.schemaFailure();
      return true;
    }
    if (value.type === "terminal.closed") {
      this.finish("closed");
      return true;
    }
    if (value.type !== "terminal.frame") {
      this.schemaFailure();
      return true;
    }
    const seq = Number(value.seq);
    const cols = Number(value.width);
    const rows = Number(value.height);
    if (
      value.encoding !== "ansi" ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      !validDimension(cols) ||
      !validDimension(rows) ||
      typeof value.full !== "boolean" ||
      typeof value.bytes !== "string"
    ) {
      this.schemaFailure();
      return true;
    }
    if (seq <= this.lastSeq) return true;
    if (!value.full && (this.lastSeq < 0 || seq !== this.lastSeq + 1)) {
      this.closeWithError("Herdr terminal frame sequence has a gap.", true);
      return true;
    }
    const bytes = strictBase64(value.bytes);
    if (!bytes) {
      this.schemaFailure();
      return true;
    }
    if (
      this.unackedFrameBytes.size >= MAX_UNACKED_FRAMES ||
      (this.unackedFrameBytes.size > 0 && this.unackedBytes + bytes.byteLength > MAX_UNACKED_FRAME_BYTES)
    ) {
      this.paused = true;
      this.child.stdout.pause();
      return false;
    }
    this.schemaErrors = 0;
    this.lastSeq = seq;
    this.unackedFrameBytes.set(seq, bytes.byteLength);
    this.unackedBytes += bytes.byteLength;
    this.onFrame(bytes.byteLength);
    this.server.emit("herdr.terminal.frame", this.terminalId, {
      terminalId: this.terminalId,
      seq,
      full: value.full,
      cols,
      rows,
      bytes: new Uint8Array(bytes),
    });
    if (this.unackedFrameBytes.size >= MAX_UNACKED_FRAMES || this.unackedBytes >= MAX_UNACKED_FRAME_BYTES) {
      this.paused = true;
      this.child.stdout.pause();
    }
    return true;
  }

  private schemaFailure(): void {
    this.schemaErrors += 1;
    if (this.schemaErrors >= 3) this.closeWithError("Herdr terminal stream violated protocol 20.");
  }

  private closeWithError(message: string, recoverObserve = false): void {
    if (this.closed) return;
    this.closed = true;
    this.onError("HERDR_TERMINAL_PROTOCOL");
    this.discardPendingCommands();
    this.emitStatus(
      "error",
      new HerdrBridgeError("HERDR_TERMINAL_PROTOCOL", message, true),
      recoverObserve ? "reopen-observe" : undefined,
    );
    this.terminate(false);
  }

  private finish(state: "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.discardPendingCommands();
    this.emitStatus(state);
    this.terminate(false);
  }

  private terminate(release: boolean): void {
    let delay = 0;
    if (release && this.mode === "control") {
      try {
        this.writeCommandWhileClosing({ type: "terminal.release" });
        delay = RELEASE_DRAIN_MS;
      } catch {
        /* process is already closing */
      }
    }
    this.terminateTimer = setTimeout(() => {
      this.terminateTimer = null;
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      this.forceKillTimer = setTimeout(() => {
        this.forceKillTimer = null;
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, TERMINATE_GRACE_MS);
      this.forceKillTimer.unref();
    }, delay);
    this.terminateTimer.unref();
  }

  private writeCommandWhileClosing(value: Record<string, unknown>): void {
    if (!this.child.stdin.writable) throw new Error("terminal stdin is closed");
    const command = `${JSON.stringify(value)}\n`;
    if (
      Math.max(this.child.stdin.writableLength, this.blockedCommandBytes) + Buffer.byteLength(command) >
      MAX_STDIN_BUFFER_BYTES
    ) {
      throw new Error("terminal stdin is backpressured");
    }
    this.child.stdin.write(command);
  }

  private finalizeClosed(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.terminateTimer = null;
    this.forceKillTimer = null;
    this.onClosed(this.terminalId);
    this.resolveClosed();
  }

  private emitStatus(
    state: HerdrTerminalStatus["state"],
    error?: HerdrBridgeError,
    recovery?: HerdrTerminalStatus["recovery"],
  ): void {
    this.server.emit("herdr.terminal.status", this.terminalId, {
      terminalId: this.terminalId,
      paneId: this.paneId,
      state,
      mode: this.mode,
      controller: this.mode === "control" && state === "controlling",
      ansiOnly: true,
      ...(error ? { error: error.toPublic() } : {}),
      ...(recovery ? { recovery } : {}),
    });
  }
}

export class HerdrTerminalRegistry {
  private sessions = new Map<string, HerdrTerminalSession>();
  private paneOperationTails = new Map<string, Promise<void>>();
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private generation = 0;
  private frames = 0;
  private frameBytes = 0;
  private recentErrorCode: HerdrErrorCode | undefined;

  constructor(
    private readonly server: RpcServer,
    private readonly crashRecovery: HerdrTerminalCrashRecovery = registerTerminalCrashRecovery,
  ) {}

  async open(
    descriptor: HerdrRuntimeDescriptor,
    paneId: string,
    mode: "observe" | "control",
    cols: number,
    rows: number,
    takeover = false,
  ): Promise<HerdrTerminalSession> {
    const generation = this.generation;
    return this.enqueuePaneOperation(paneId, () =>
      this.openSerialized(descriptor, paneId, mode, cols, rows, takeover, generation),
    );
  }

  private async openSerialized(
    descriptor: HerdrRuntimeDescriptor,
    paneId: string,
    mode: "observe" | "control",
    cols: number,
    rows: number,
    takeover: boolean,
    generation: number,
  ): Promise<HerdrTerminalSession> {
    this.assertCurrentGeneration(generation);
    if (mode === "observe") {
      const existing = [...this.sessions.values()].find(
        (candidate) => candidate.paneId === paneId && candidate.mode === "observe",
      );
      if (existing) await existing.close(false);
    }
    if (mode === "control") {
      const existing = [...this.sessions.values()].find(
        (candidate) => candidate.paneId === paneId && candidate.mode === "control",
      );
      if (existing && !takeover) {
        throw new HerdrBridgeError("HERDR_TERMINAL_BUSY", "This pane already has a Pi Desktop terminal controller.");
      }
      if (existing) await existing.close(true);
    }
    this.assertCurrentGeneration(generation);
    if (this.sessions.size >= MAX_TERMINAL_SESSIONS) {
      throw new HerdrBridgeError("HERDR_PROTOCOL_LIMIT_EXCEEDED", "At most 8 Herdr terminal views may be open.");
    }
    const session = new HerdrTerminalSession(
      this.server,
      descriptor,
      paneId,
      mode,
      cols,
      rows,
      takeover,
      (terminalId) => {
        this.sessions.delete(terminalId);
        this.cancelOrphanRelease(terminalId);
      },
      (bytes) => {
        this.frames += 1;
        this.frameBytes += bytes;
      },
      (code) => {
        this.recentErrorCode = code;
      },
      this.crashRecovery,
    );
    this.sessions.set(session.terminalId, session);
    try {
      await session.ready();
    } catch {
      await session.close(false);
      this.assertCurrentGeneration(generation);
      throw new HerdrBridgeError("HERDR_TERMINAL_PROTOCOL", "Herdr terminal containment failed.", true);
    }
    if (generation !== this.generation) {
      await session.close(mode === "control");
      throw new HerdrBridgeError(
        "HERDR_ENDPOINT_UNAVAILABLE",
        "The Herdr connection changed while the terminal was opening.",
        true,
      );
    }
    return session;
  }

  diagnostics(): {
    streams: number;
    controllers: number;
    frames: number;
    bytes: number;
    recentErrorCode?: HerdrErrorCode;
  } {
    return {
      streams: this.sessions.size,
      controllers: [...this.sessions.values()].filter((session) => session.mode === "control").length,
      frames: this.frames,
      bytes: this.frameBytes,
      ...(this.recentErrorCode ? { recentErrorCode: this.recentErrorCode } : {}),
    };
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation === this.generation) return;
    throw new HerdrBridgeError(
      "HERDR_ENDPOINT_UNAVAILABLE",
      "The Herdr connection changed while the terminal was queued.",
      true,
    );
  }

  private async enqueuePaneOperation<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.paneOperationTails.get(paneId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.paneOperationTails.set(paneId, tail);
    try {
      return await result;
    } finally {
      if (this.paneOperationTails.get(paneId) === tail) this.paneOperationTails.delete(paneId);
    }
  }

  get(terminalId: string): HerdrTerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new HerdrBridgeError("HERDR_TERMINAL_NOT_FOUND", "Terminal bridge was not found.");
    return session;
  }

  close(terminalId: string, release: boolean): Promise<void> {
    this.cancelOrphanRelease(terminalId);
    const session = this.get(terminalId);
    return session.close(release);
  }

  scheduleOrphanRelease(terminalId: string, graceMs = 10_000): void {
    this.cancelOrphanRelease(terminalId);
    if (!this.sessions.has(terminalId)) return;
    const timer = setTimeout(() => {
      this.orphanTimers.delete(terminalId);
      if (!this.sessions.has(terminalId)) return;
      void this.close(terminalId, true).catch(() => undefined);
    }, graceMs);
    timer.unref();
    this.orphanTimers.set(terminalId, timer);
  }

  cancelOrphanRelease(terminalId: string): void {
    const timer = this.orphanTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.orphanTimers.delete(terminalId);
  }

  async closeAll(release: boolean): Promise<void> {
    this.generation += 1;
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
    await Promise.all([...this.sessions.values()].map((session) => session.close(release)));
  }
}
