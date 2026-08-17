import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { terminateProcessTree } from "./process-tree.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.removeListener("close", onClose);
      reject(error);
    };
    const onClose = (code: number | null) => {
      child.removeListener("error", onError);
      resolve(code);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

/** Local bash exec that waits for Windows taskkill instead of fire-and-forget. */
export async function execDesktopBash(
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
  shellPath?: string,
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  try {
    await fsAccess(cwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
  }

  const timeoutMs = resolveTimeoutMs(options.timeout);
  const shellConfig = getShellConfig(shellPath);
  const commandFromStdin = shellConfig.commandTransport === "stdin";
  const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
    cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (commandFromStdin) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(command);
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const kill = () => {
    void terminateProcessTree(child, 400);
  };
  const onAbort = () => kill();

  try {
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const exitCode = await waitForClose(child);
    if (options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeout}`);
    return { exitCode };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
