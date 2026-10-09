import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import {
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
} from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "../../contract/mcp";
import { callMain } from "../parent-rpc";
import { toolchainRuntime } from "../toolchain-runtime";
import { PosixManagedProcessBackend } from "../managed-process/posix-backend";
import type { ManagedProcessBackend, PreparedContainment } from "../managed-process/backend";
import { WindowsByteProcessChild } from "../managed-process/windows-byte-child";
import type { ToolchainRuntime } from "../toolchain-runtime";
import { safeChannelError } from "../channels/redaction";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const quote = (value: string) => "'" + value.replace(/'/gu, "'\"'\"'") + "'";
export interface ContainedMcpOptions {
  config: McpServerConfig;
  cwd: string;
  trusted: boolean;
  env?: Record<string, string>;
  onStderr?: (text: string) => void;
  runtime?: ToolchainRuntime;
  parentCall?: typeof callMain;
  backendFactory?: () => ManagedProcessBackend;
  workerEntryPath?: string;
  workerExecArgv?: string[];
}

/** Raw protocol bytes over the existing process-group / Windows Job containment, bypassing process log buffers. */
export class ContainedMcpStdioTransport implements McpTransport {
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  private backend?: ManagedProcessBackend;
  private windowsChild?: WindowsByteProcessChild;
  private prepared?: PreparedContainment;
  private unregister?: () => void;
  private started = false;
  private closed = false;
  private closing?: Promise<void>;
  private registered = false;
  private cleanup?: Promise<void>;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stderrBuffer = "";
  constructor(private readonly options: ContainedMcpOptions) {}
  onMessage(listener: McpTransportMessageListener) {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }
  onError(listener: McpTransportErrorListener) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }
  onClose(listener: McpTransportCloseListener) {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("MCP transport has already started or closed");
    this.started = true;
    const runtime = this.options.runtime ?? toolchainRuntime;
    const context = await runtime.createExecutionContext({
      cwd: this.options.cwd,
      intent: "managed-process",
      trusted: this.options.trusted,
    });
    const parent = this.options.parentCall ?? callMain;
    const settings = await parent<{
      reaperReady?: boolean;
      capability?: { ready?: boolean };
      containmentCapability?: { ready?: boolean };
    }>("managedProcesses.getSettings", undefined, 5000);
    if (this.closed || this.closing) throw new Error("MCP connection was cancelled");
    const capability = settings.containmentCapability ?? settings.capability;
    if (!settings.reaperReady || !capability?.ready) throw new Error("MCP process containment is not ready");
    const config = this.options.config;
    if (!config.command) throw new Error("MCP stdio command is missing");
    const environment = { ...context.shellEnv, ...this.options.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    if (process.platform === "win32") {
      const child = new WindowsByteProcessChild(
        process.execPath,
        [path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-stdio-launcher.mjs")],
        randomUUID(),
        {
          cwd: this.options.cwd,
          env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
          processPrefix: "mcp",
          capabilityScope: "transport",
        },
      );
      this.windowsChild = child;
      child.stdout.on("data", (bytes: Buffer) => this.read(bytes));
      child.stderr.on("data", (bytes: Buffer) => this.stderr(bytes));
      child.on("error", (error: Error) => this.fail(error));
      child.once("close", () => this.finish());
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(
          JSON.stringify({
            command: config.command,
            args: config.args ?? [],
            cwd: this.options.cwd,
            env: environment,
          }) + "\n",
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      return;
    }
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("MCP stdio requires process containment on this platform");
    const shell = runtime.requireFromContext("shell.bash", context);
    const backend =
      this.options.backendFactory?.() ??
      new PosixManagedProcessBackend({
        platform: process.platform,
        workerEntryPath:
          this.options.workerEntryPath ??
          path.join(path.dirname(fileURLToPath(import.meta.url)), "managed-process-worker.mjs"),
        workerExecArgv: this.options.workerExecArgv,
        hostInstanceId: randomUUID(),
      });
    this.backend = backend;
    this.unregister = backend.onEvent((event) => {
      if (event.type === "stdout") this.read(event.bytes);
      else if (event.type === "stderr") this.stderr(event.bytes);
      else if (event.type === "exit") {
        void this.cleanupReaper(parent)
          .finally(() => this.finish())
          .catch((error) => this.fail(error));
      } else if (event.type === "error" || event.type === "output-dropped")
        this.fail(new Error("MCP protocol process output failed"));
    });
    try {
      const processId = "mcp-" + randomUUID(),
        runId = randomUUID();
      const prepared = await backend.prepare({
        processId,
        runId,
        cwd: this.options.cwd,
        command: "exec " + [config.command, ...(config.args ?? [])].map(quote).join(" "),
        shell,
        context: { ...context, shellEnv: environment },
      });
      this.prepared = prepared;
      if (this.closed || this.closing) throw new Error("MCP connection was cancelled");
      const registered = await parent<{ journalRevision?: number }>(
        "managedProcesses.register",
        { record: prepared.reaper },
        5000,
      );
      if (!Number.isSafeInteger(registered.journalRevision) || registered.journalRevision! <= 0)
        throw new Error("MCP crash recovery registration failed");
      this.registered = true;
      if (this.closed || this.closing) throw new Error("MCP connection was cancelled");
      await backend.commit(prepared, registered.journalRevision!);
    } catch (error) {
      await backend.dispose();
      await this.cleanupReaper(parent);
      throw error;
    }
  }
  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.started || this.closed) throw new Error("MCP transport is closed");
    const text = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error("MCP message exceeds the protocol budget");
    if (this.windowsChild)
      await new Promise<void>((resolve, reject) =>
        this.windowsChild!.stdin.write(text, (error) => (error ? reject(error) : resolve())),
      );
    else if (this.backend) this.backend.write({ text, appendNewline: false, close: false });
    else throw new Error("MCP protocol process is not ready");
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.closed) return;
      if (this.windowsChild) {
        const child = this.windowsChild;
        const done = new Promise<void>((resolve) => child.once("close", resolve));
        child.kill("SIGKILL");
        await done;
      } else if (this.backend) {
        await this.backend.stop("force", "host");
        await this.backend.dispose();
        await this.cleanupReaper(this.options.parentCall ?? callMain);
      }
      this.unregister?.();
      this.finish();
    })());
  }
  private read(bytes: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.fail(new Error("MCP response exceeds the protocol budget"));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = parseJsonRpcMessage(JSON.parse(line));
        for (const listener of this.messageListeners) listener(message);
      } catch {
        this.fail(new Error("Invalid MCP JSON-RPC output"));
        return;
      }
    }
  }
  private stderr(bytes: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.write(bytes);
    let newline: number;
    while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
      this.diagnostic(this.stderrBuffer.slice(0, newline));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
    }
    if (this.stderrBuffer.length > 16384) {
      this.options.onStderr?.("MCP stderr line exceeded the diagnostics budget");
      this.stderrBuffer = "";
    }
  }
  private diagnostic(line: string): void {
    for (const [key, value] of Object.entries(this.options.env ?? {}))
      if (value && /token|secret|key|password|credential|auth/iu.test(key)) line = line.split(value).join("[REDACTED]");
    if (line.trim()) this.options.onStderr?.(safeChannelError(line));
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    for (const listener of this.errorListeners)
      listener(error instanceof Error ? error : new Error("MCP transport failed"));
    void this.close().catch(() => this.finish());
  }
  private finish(): void {
    if (this.closed) return;
    this.diagnostic(this.stderrBuffer + this.stderrDecoder.end());
    this.stderrBuffer = "";
    this.closed = true;
    this.buffer = "";
    for (const listener of this.closeListeners) listener();
  }
  private async cleanupReaper(parent: typeof callMain): Promise<void> {
    const reaper = this.prepared?.reaper;
    if (!reaper || !this.registered) return;
    await (this.cleanup ??= parent(
      "managedProcesses.unregister",
      { hostInstanceId: reaper.hostInstanceId, processId: reaper.processId, runId: reaper.runId, nonce: reaper.nonce },
      5000,
    ).then(() => undefined));
    this.prepared = undefined;
  }
}
