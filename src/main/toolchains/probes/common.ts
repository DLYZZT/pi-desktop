import { createHash } from "node:crypto";
import path from "node:path";
import type { ToolCandidate, ToolHealth, ToolchainErrorCode } from "../../../shared/toolchains/types";
import type { ExecutableSeed } from "../discovery-registry.ts";
import type { ProbeCommand, ProbeExecutor, ProbeResult } from "../process-runner.ts";
import { probeSucceeded } from "../process-runner.ts";

const PRESERVED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

function environmentValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actualKey ? env[actualKey] : undefined;
}

export function buildProbeEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  binDir: string,
  platform: NodeJS.Platform,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PRESERVED_ENV_KEYS) {
    const value = environmentValue(baseEnv, key, platform);
    if (value !== undefined) env[key] = value;
  }
  const originalPath = environmentValue(baseEnv, "PATH", platform) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  env.UV_PYTHON_DOWNLOADS = "manual";
  env.UV_NO_MODIFY_PATH = "1";
  return { ...env, ...extra };
}

export function toolCandidateId(
  seed: ExecutableSeed,
  executable = seed.executable,
  argvPrefix = seed.argvPrefix,
): string {
  const digest = createHash("sha256")
    .update(seed.capability)
    .update("\0")
    .update(seed.provider)
    .update("\0")
    .update(executable)
    .update("\0")
    .update(argvPrefix.join("\0"))
    .digest("hex")
    .slice(0, 20);
  return `${seed.capability}:${digest}`;
}

export function candidateFromSeed(
  seed: ExecutableSeed,
  options: {
    executable?: string;
    argvPrefix?: string[];
    version?: string;
    health?: ToolHealth;
    reasonCode?: ToolchainErrorCode;
    componentRoot?: string;
  } = {},
): ToolCandidate {
  const executable = options.executable ?? seed.executable;
  const argvPrefix = options.argvPrefix ?? seed.argvPrefix;
  const pathApi = /^(?:[A-Za-z]:\\|\\\\)/.test(executable) ? path.win32 : path.posix;
  return {
    id: toolCandidateId(seed, executable, argvPrefix),
    capability: seed.capability,
    provider: seed.provider,
    discovery: seed.discovery,
    executable,
    argvPrefix,
    binDir: pathApi.dirname(executable),
    version: options.version,
    componentId: seed.componentId,
    componentRoot: options.componentRoot ?? seed.componentRoot,
    health: options.health ?? "healthy",
    reasonCode: options.reasonCode,
    rank: seed.rank,
    pathOrder: seed.pathOrder,
    discoveredAt: new Date().toISOString(),
  };
}

export function failedCandidate(seed: ExecutableSeed, result?: ProbeResult): ToolCandidate {
  const permissionFailure = result?.spawnErrorCode === "EACCES" || result?.spawnErrorCode === "EPERM";
  return candidateFromSeed(seed, {
    health: "broken",
    reasonCode: permissionFailure ? "TOOLCHAIN_PERMISSION_DENIED" : "TOOLCHAIN_BROKEN",
  });
}

export async function executeSeedProbe(
  executor: ProbeExecutor,
  seed: ExecutableSeed,
  args: string[],
  options: Omit<ProbeCommand, "executable" | "args"> = {},
): Promise<ProbeResult> {
  return executor.run({
    ...options,
    executable: seed.executable,
    args: [...seed.argvPrefix, ...args],
  });
}

export function requireSuccessfulProbe(seed: ExecutableSeed, result: ProbeResult): ToolCandidate | undefined {
  return probeSucceeded(result) ? undefined : failedCandidate(seed, result);
}

export function firstVersion(text: string): string | undefined {
  return text.match(/\bv?(\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
