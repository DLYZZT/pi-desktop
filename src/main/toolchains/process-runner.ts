import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface ProbeCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export interface ProbeResult {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnErrorCode?: string;
  durationMs: number;
}

export interface ProbeExecutor {
  run(command: ProbeCommand): Promise<ProbeResult>;
}

function boundedAppend(chunks: Buffer[], chunk: Buffer, currentBytes: number, limit: number): number {
  if (currentBytes >= limit) return currentBytes;
  const remaining = limit - currentBytes;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return currentBytes + Math.min(chunk.length, remaining);
}

export async function runProbeCommand(command: ProbeCommand): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, command.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const outputLimitBytes = Math.max(1, command.outputLimitBytes ?? DEFAULT_PROBE_OUTPUT_LIMIT_BYTES);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let spawnErrorCode: string | undefined;

  const options: SpawnOptions = {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    windowsHide: true,
    stdio: [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  };

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command.executable, command.args, options);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      resolve({
        executable: command.executable,
        args: [...command.args],
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        spawnErrorCode: typeof code === "string" ? code : "SPAWN_FAILED",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executable: command.executable,
        args: [...command.args],
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        outputLimitExceeded,
        spawnErrorCode,
        durationMs: Date.now() - startedAt,
      });
    };

    const stopForOutputLimit = (): void => {
      outputLimitExceeded = true;
      try {
        child.kill();
      } catch {
        /* process may already have exited */
      }
    };

    child.stdout?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const previous = stdoutBytes;
      stdoutBytes = boundedAppend(stdoutChunks, chunk, stdoutBytes, outputLimitBytes);
      if (previous + chunk.length > outputLimitBytes) stopForOutputLimit();
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const previous = stderrBytes;
      stderrBytes = boundedAppend(stderrChunks, chunk, stderrBytes, outputLimitBytes);
      if (previous + chunk.length > outputLimitBytes) stopForOutputLimit();
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? "SPAWN_FAILED";
      finish(null, null);
    });
    child.once("close", finish);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* process may already have exited */
      }
    }, timeoutMs);
    timer.unref();

    if (command.input !== undefined) {
      child.stdin?.end(command.input);
    }
  });
}

export const defaultProbeExecutor: ProbeExecutor = {
  run: runProbeCommand,
};

export function probeSucceeded(result: ProbeResult): boolean {
  return (
    result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && result.spawnErrorCode === undefined
  );
}
