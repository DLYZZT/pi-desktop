import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolExecutionContext } from "../shared/toolchains/types";
import { TOOLCHAIN_ERROR_CODES } from "../shared/toolchains/types.ts";
import { ToolchainError } from "../shared/toolchains/errors.ts";
import type { PluginsResponse } from "../shared/api-types";
import {
  PLUGIN_WORKER_RESULT_MARKER,
  type PluginWorkerRequest,
  type PluginWorkerResponse,
} from "./plugin-worker-protocol.ts";

const PLUGIN_WORKER_TIMEOUT_MS = 3 * 60_000;
const OUTPUT_TAIL_LIMIT = 2 * 1024 * 1024;

export interface PluginWorkerClientOptions {
  entryPath?: string;
  execPath?: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

function spawnEnvironment(context: ToolExecutionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(context.nativeEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.PI_DESKTOP_PLUGIN_WORKER = "1";
  env.PI_DESKTOP_TOOLCHAIN_REVISION = String(context.inventoryRevision);
  return env;
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_LIMIT ? combined : combined.subarray(combined.length - OUTPUT_TAIL_LIMIT);
}

function safeWorkerMessage(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(?:npm_|NODE_AUTH_TOKEN|token)[=:]\s*[^\s]+/gi, "token=[redacted]")
    .slice(0, 1_000);
}

export function extractPluginWorkerResponse(output: string): PluginWorkerResponse | undefined {
  const markerIndex = output.lastIndexOf(PLUGIN_WORKER_RESULT_MARKER);
  if (markerIndex < 0) return undefined;
  const encoded = output
    .slice(markerIndex + PLUGIN_WORKER_RESULT_MARKER.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PluginWorkerResponse;
  } catch {
    return undefined;
  }
}

function responseError(response: Extract<PluginWorkerResponse, { ok: false }>): ToolchainError {
  const code = (TOOLCHAIN_ERROR_CODES as readonly string[]).includes(response.error.code)
    ? response.error.code
    : "TOOLCHAIN_INTERNAL";
  const message = safeWorkerMessage(response.error.message);
  if (/\b(?:spawn|run)\s+(?:npm|node)\b.*(?:ENOENT|not found)/i.test(message)) {
    return new ToolchainError({ code: "TOOLCHAIN_NODE_REQUIRED", capability: "js.npm", message });
  }
  if (/\b(?:spawn|run)\s+git\b.*(?:ENOENT|not found)/i.test(message)) {
    return new ToolchainError({ code: "TOOLCHAIN_GIT_REQUIRED", capability: "vcs.git", message });
  }
  return new ToolchainError({ code, message });
}

export async function runPluginWorker(
  request: PluginWorkerRequest,
  context: ToolExecutionContext,
  options: PluginWorkerClientOptions = {},
): Promise<PluginsResponse> {
  const entryPath = options.entryPath ?? join(dirname(fileURLToPath(import.meta.url)), "plugin-worker.mjs");
  const executable = options.execPath ?? process.execPath;
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? PLUGIN_WORKER_TIMEOUT_MS;
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Plugin worker request is too large" });
  }

  return new Promise<PluginsResponse>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, [entryPath], {
        env: spawnEnvironment(context),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new ToolchainError({
          code: "TOOLCHAIN_INTERNAL",
          message: "Could not start the isolated Plugin worker",
          cause: error,
        }),
      );
      return;
    }

    let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.stdout?.on("data", (value: Buffer | string) => {
      stdoutTail = appendTail(stdoutTail, Buffer.isBuffer(value) ? value : Buffer.from(value));
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      stderrTail = appendTail(stderrTail, Buffer.isBuffer(value) ? value : Buffer.from(value));
    });
    child.once("error", (error) => {
      finish(() =>
        reject(
          new ToolchainError({
            code: "TOOLCHAIN_INTERNAL",
            message: "The isolated Plugin worker failed to start",
            cause: error,
          }),
        ),
      );
    });
    child.once("close", (exitCode) => {
      finish(() => {
        const response = extractPluginWorkerResponse(stdoutTail.toString("utf8"));
        if (response?.ok) {
          resolve(response.result);
          return;
        }
        if (response && !response.ok) {
          reject(responseError(response));
          return;
        }
        const detail = safeWorkerMessage(stderrTail.toString("utf8").trim());
        reject(
          new ToolchainError({
            code: "TOOLCHAIN_INTERNAL",
            message: detail
              ? `Plugin worker exited without a result (${exitCode ?? "signal"}): ${detail}`
              : `Plugin worker exited without a result (${exitCode ?? "signal"})`,
          }),
        );
      });
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* worker already exited */
      }
      finish(() => reject(new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Plugin worker timed out" })));
    }, timeoutMs);
    timer.unref();
    child.stdin?.end(input);
  });
}
