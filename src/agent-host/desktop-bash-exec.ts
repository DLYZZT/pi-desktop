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

const EXIT_STDIO_GRACE_MS = 100;

/** Wait for exit without hanging on inherited SSH/stdio handles. Pi #5303. */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onIdleData);
      child.stderr?.removeListener("data", onIdleData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onIdleData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onIdleData);
    child.stderr?.on("data", onIdleData);
    child.once("error", onError);
    child.once("exit", onExit);
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

  const childPid = child.pid;
  if (childPid) bashChildListener?.(childPid, true);

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const kill = () => {
    if (child.pid) {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
    }
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
    const exitCode = await waitForChildProcess(child);
    if (options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeout}`);
    return { exitCode };
  } finally {
    if (childPid) bashChildListener?.(childPid, false);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

type BashChildListener = (pid: number, alive: boolean) => void;
let bashChildListener: BashChildListener | undefined;

export function setBashChildListener(listener?: BashChildListener): void {
  bashChildListener = listener;
}
