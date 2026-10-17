import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  createPowerShellToolDefinition,
  type PowerShellToolOptions,
  type PowerShellToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { CommandDescriptor, ToolExecutionContext } from "../shared/toolchains/types.ts";
import { ToolchainError } from "../shared/toolchains/errors.ts";
import { terminateProcessTree } from "../shared/node/process-tree.ts";
import { sanitizeToolEnvironment } from "./tool-environment.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}

async function checkBeforeExecution(
  check: ((command: string) => Promise<void>) | undefined,
  command: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  if (!check) return;
  if (!signal) {
    await check(command);
    return;
  }
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return check(command);
      }),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Use a conservative CreateProcessW budget including quoting, argv[0], separators and the terminator. */
export function powerShellArguments(descriptor: CommandDescriptor, command: string): string[] {
  // Windows PowerShell 5.1 forces redirected stderr to CLIXML for -EncodedCommand,
  // even with -OutputFormat Text. Keep the payload encoded, but use a fixed ASCII
  // bootstrap. Capture the final status inside the script block: invoking a block
  // alone would turn a failing native command into a successful shell exit.
  const encoded = Buffer.from(UTF8_OUTPUT_PREFIX + command + "\nexit ([int](-not $?))", "utf16le").toString("base64");
  const bootstrap = `& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  const args = [
    ...descriptor.argvPrefix,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-OutputFormat",
    "Text",
    "-Command",
    bootstrap,
  ];
  const budget = [descriptor.executable, ...args].reduce(
    (size, value) => size + value.length + (value.match(/[\\"]/gu)?.length ?? 0) + 3,
    1,
  );
  if (budget > 32_767)
    throw new ToolchainError({
      code: "TOOL_COMMAND_TOO_LONG",
      capability: "shell.powershell",
      message:
        "TOOL_COMMAND_TOO_LONG: PowerShell script exceeds the Windows command-line budget. Shorten the script; it was not executed.",
    });
  return args;
}

/** Drain active output after exit, but do not hang on a quiet pipe inherited by a descendant. */
function waitForShellExit(
  child: ChildProcess,
  onData: (data: Buffer) => void,
  stopped: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let exited = false,
      settled = false,
      exitCode: number | null = null,
      drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(drain);
      child.off("exit", exit).off("close", close).off("error", fail);
      stopped.removeEventListener("abort", stop);
      for (const output of outputs) output.stream?.off("data", output.listener).destroy();
      if (!error) {
        try {
          for (const output of outputs) emit(output.decoder.end());
        } catch (cause) {
          error = cause as Error;
        }
      }
      if (error) reject(error);
      else resolve(exitCode);
    };
    const armDrain = () => {
      clearTimeout(drain);
      drain = setTimeout(() => finish(), 100);
    };
    const emit = (text: string) => {
      if (text) onData(Buffer.from(text, "utf8"));
    };
    const data = (decoder: StringDecoder, chunk: Buffer) => {
      try {
        emit(decoder.write(chunk));
      } catch (error) {
        finish(error as Error);
        return;
      }
      if (exited) armDrain();
    };
    // The SDK sees one stream. Complete UTF-8 characters in each pipe before merging
    // so stderr cannot be inserted between the bytes of a stdout character (or vice versa).
    const outputs = [child.stdout, child.stderr].map((stream) => {
      const decoder = new StringDecoder("utf8");
      return { stream, decoder, listener: (chunk: Buffer) => data(decoder, chunk) };
    });
    const exit = (code: number | null) => {
      exited = true;
      exitCode = code;
      armDrain();
    };
    const close = (code: number | null) => {
      exitCode = code;
      finish();
    };
    const fail = (error: Error) => finish(error);
    const stop = () => finish();
    for (const output of outputs) output.stream?.on("data", output.listener);
    child.once("error", fail).once("exit", exit).once("close", close);
    stopped.addEventListener("abort", stop, { once: true });
    if (stopped.aborted) stop();
  });
}

export function createToolchainPowerShellOptions(
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
  beforeExec?: (command: string) => Promise<void>,
  assertAuthorized?: () => void,
): PowerShellToolOptions {
  return {
    spawnHook(spawnContext) {
      // Inherit only the SDK's explicitly public session fields, never its Host PATH/shell environment.
      const env = { ...context.nativeEnv };
      for (const key of Object.keys(env)) if (SESSION_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
      for (const key of SESSION_ENV_KEYS) {
        delete env[key];
        if (spawnContext.env[key] !== undefined) env[key] = spawnContext.env[key];
      }
      return { ...spawnContext, env: sanitizeToolEnvironment(env) };
    },
    operations: {
      async exec(command, cwd, { onData, signal, timeout, env }) {
        throwIfAborted(signal);
        assertAuthorized?.();
        const descriptor = runtime.requireFromContext("shell.powershell", context);
        const args = powerShellArguments(descriptor, command);
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647))
          throw new Error("Invalid timeout: must be a positive finite number of seconds within the timer limit");
        await checkBeforeExecution(beforeExec, command, signal);
        throwIfAborted(signal);
        // Authorization/source can change while the raw-command policy check waits for local approval.
        assertAuthorized?.();
        const child = spawn(descriptor.executable, args, {
          cwd,
          env: sanitizeToolEnvironment(env ?? context.nativeEnv),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false,
          terminationError: unknown,
          termination: Promise<void> | undefined;
        const stopped = new AbortController();
        const stop = () => {
          termination ??= terminateProcessTree(child, 1_000, true)
            .catch((error) => {
              terminationError = error;
            })
            .finally(() => stopped.abort());
        };
        const timer =
          timeout === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                stop();
              }, timeout * 1000);
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        try {
          const exitCode = await waitForShellExit(child, onData, stopped.signal);
          await termination;
          if (terminationError) throw terminationError;
          if (signal?.aborted) throw new Error("aborted");
          if (timedOut) throw new Error(`timeout:${timeout}`);
          return { exitCode: exitCode ?? 1 };
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) stop();
          await termination;
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          await termination;
        }
      },
    },
  };
}

export function createDesktopPowerShellTool(
  cwd: string,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
  beforeExec?: (command: string) => Promise<void>,
  assertAuthorized?: () => void,
) {
  const definition = createPowerShellToolDefinition(
    cwd,
    createToolchainPowerShellOptions(context, runtime, beforeExec, assertAuthorized),
  );
  return {
    ...definition,
    defaultActive: false,
    async execute(...args: Parameters<typeof definition.execute>) {
      let latest: PowerShellToolDetails | undefined;
      try {
        return await definition.execute(
          args[0],
          args[1],
          args[2],
          (update) => {
            latest = update.details ?? latest;
            args[3]?.(update);
          },
          args[4],
        );
      } catch (error) {
        // Pi throws on cancellation/timeout after its final update. Retain its spill path for durable history.
        if (latest?.fullOutputPath && error instanceof Error)
          return { content: [{ type: "text" as const, text: error.message }], details: latest, isError: true };
        throw error;
      }
    },
  };
}
