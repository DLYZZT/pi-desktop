import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

const execFileAsync = promisify(execFile);

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
  const result = await execFileAsync(npx.executable, [...npx.argvPrefix, ...args], {
    timeout: opts.timeout,
    cwd,
    env: { ...context.nativeEnv, ...opts.env, FORCE_COLOR: "0" },
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
