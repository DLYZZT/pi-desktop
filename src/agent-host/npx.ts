import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

const execFileAsync = promisify(execFile);

const NPM_EXEC_ENV: NodeJS.ProcessEnv = {
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_yes: "true",
};

interface NpxFailure extends Error {
  code?: string | number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

function failureOutput(failure: NpxFailure): string {
  return `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
}

function shouldRetryWithIsolatedCache(failure: NpxFailure): boolean {
  const output = failureOutput(failure);
  if (/Installation complete|Installed \d+ skills?/i.test(output)) return false;
  if (failure.killed) return true;
  if (
    typeof failure.code === "string" &&
    [
      "EAI_AGAIN",
      "EBUSY",
      "ECOMPROMISED",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETDOWN",
      "ENETUNREACH",
      "ETIMEDOUT",
    ].includes(failure.code)
  ) {
    return true;
  }
  return /concurrency\.lock|lock compromised|network (?:error|timeout)|fetch (?:error|failed)|socket hang up|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETDOWN|ENETUNREACH|ETIMEDOUT/i.test(
    output,
  );
}

function normalizeNpxFailure(failure: NpxFailure, timeoutMs?: number): NpxFailure {
  if (!timeoutMs || !failure.killed) return failure;
  const timeout = new Error(
    `Developer command timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Check network connectivity and try again.`,
  ) as NpxFailure;
  timeout.stdout = String(failure.stdout ?? "");
  timeout.stderr = String(failure.stderr ?? "");
  return timeout;
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute the Main-resolved Node + npx-cli.js pair. Discovery belongs to Main;
 * the Host never scans PATH, guesses npm layout, or treats Electron as Node.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  return runNpxWithRuntime(args, opts, toolchainRuntime);
}

export async function runNpxWithRuntime(
  args: string[],
  opts: RunNpxOptions,
  runtime: ToolchainRuntime,
): Promise<RunNpxResult> {
  const cwd = opts.cwd ?? process.cwd();
  const context = await runtime.createExecutionContext({ cwd, intent: "skill-install" });
  const npx = runtime.requireFromContext("js.npx", context);
  const execute = async (recoveryEnv: NodeJS.ProcessEnv = {}): Promise<RunNpxResult> => {
    const result = await execFileAsync(npx.executable, [...npx.argvPrefix, ...args], {
      timeout: opts.timeout,
      cwd,
      env: { ...context.nativeEnv, ...NPM_EXEC_ENV, ...opts.env, ...recoveryEnv, FORCE_COLOR: "0" },
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };

  try {
    return await execute();
  } catch (error) {
    const failure = error as NpxFailure;
    if (!shouldRetryWithIsolatedCache(failure)) throw normalizeNpxFailure(failure, opts.timeout);

    const retryCache = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-npx-retry-"));
    try {
      return await execute({ npm_config_cache: retryCache, npm_config_maxsockets: "1" });
    } catch (retryError) {
      throw normalizeNpxFailure(retryError as NpxFailure, opts.timeout);
    } finally {
      await rm(retryCache, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
