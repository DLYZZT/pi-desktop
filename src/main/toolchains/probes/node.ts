import path from "node:path";
import type { ToolCandidate, ToolHealth, ToolchainErrorCode } from "../../../shared/toolchains/types";
import { normalizeToolPath } from "../candidate-normalizer.ts";
import type { DiscoveryFileSystem, ExecutableSeed } from "../discovery-registry.ts";
import type { ProbeExecutor } from "../process-runner.ts";
import { probeSucceeded } from "../process-runner.ts";
import { buildProbeEnvironment, candidateFromSeed, compareVersions, failedCandidate } from "./common.ts";

const MINIMUM_NODE_VERSION = "22.19.0";
const MAXIMUM_VERIFIED_NODE_MAJOR = 24;

interface NodeProbePayload {
  execPath?: string;
  versions?: { node?: string };
  arch?: string;
  platform?: string;
}

export interface NodeProbeOptions {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  fileSystem: DiscoveryFileSystem;
  executor: ProbeExecutor;
}

function parseNodePayload(stdout: string): NodeProbePayload | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as NodeProbePayload;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function nodeHealth(version: string): { health: ToolHealth; reasonCode?: ToolchainErrorCode } {
  if (compareVersions(version, MINIMUM_NODE_VERSION) < 0) {
    return { health: "unsupported", reasonCode: "TOOLCHAIN_UNSUPPORTED" };
  }
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  if (major > MAXIMUM_VERIFIED_NODE_MAJOR) {
    return { health: "unverified", reasonCode: "TOOLCHAIN_UNVERIFIED" };
  }
  return { health: "healthy" };
}

function candidateCliPaths(nodeExecutable: string, cli: "npm" | "npx", platform: NodeJS.Platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathApi.dirname(nodeExecutable);
  const filename = `${cli}-cli.js`;
  return [
    pathApi.join(nodeDir, "node_modules", "npm", "bin", filename),
    pathApi.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", filename),
    pathApi.join(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", filename),
  ];
}

function findCli(executables: readonly string[], cli: "npm" | "npx", options: NodeProbeOptions): string | undefined {
  const seen = new Set<string>();
  for (const nodeExecutable of executables) {
    for (const candidate of candidateCliPaths(nodeExecutable, cli, options.platform)) {
      const normalized = normalizeToolPath(candidate, options.platform);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (options.fileSystem.isFile(normalized)) return normalized;
    }
  }
  return undefined;
}

function coupledSeed(seed: ExecutableSeed, capability: "js.npm" | "js.npx"): ExecutableSeed {
  return { ...seed, capability };
}

export async function probeNodeDistribution(seed: ExecutableSeed, options: NodeProbeOptions): Promise<ToolCandidate[]> {
  const env = buildProbeEnvironment(options.env, seed.binDir, options.platform);
  const nodeResult = await options.executor.run({
    executable: seed.executable,
    args: [
      ...seed.argvPrefix,
      "-e",
      "process.stdout.write(JSON.stringify({execPath:process.execPath,versions:process.versions,arch:process.arch,platform:process.platform}))",
    ],
    env,
  });
  if (!probeSucceeded(nodeResult)) return [failedCandidate(seed, nodeResult)];

  const payload = parseNodePayload(nodeResult.stdout);
  const version = payload?.versions?.node;
  if (!payload || !version || payload.platform !== options.platform || !payload.arch) {
    return [failedCandidate(seed, nodeResult)];
  }
  const isRosettaCandidate =
    options.platform === "darwin" &&
    options.arch === "arm64" &&
    payload.arch === "x64" &&
    (seed.provider === "system" || seed.provider === "custom");
  if (payload.arch !== options.arch && !isRosettaCandidate) return [failedCandidate(seed, nodeResult)];
  const effectiveSeed = isRosettaCandidate ? { ...seed, rank: seed.rank + 10_000 } : seed;

  const reportedExecutable = normalizeToolPath(payload.execPath ?? "", options.platform);
  const executable =
    reportedExecutable && options.fileSystem.isFile(reportedExecutable) ? reportedExecutable : seed.executable;
  const pathApi = options.platform === "win32" ? path.win32 : path.posix;
  const componentRoot =
    options.platform === "win32" ? pathApi.dirname(executable) : pathApi.dirname(pathApi.dirname(executable));
  const versionHealth = nodeHealth(version);
  const nodeCandidate = candidateFromSeed(effectiveSeed, {
    executable,
    version,
    componentRoot,
    ...versionHealth,
  });
  const executableCandidates = executable === seed.executable ? [executable] : [executable, seed.executable];

  const pairedCandidates: ToolCandidate[] = [nodeCandidate];
  for (const cli of ["npm", "npx"] as const) {
    const cliSeed = coupledSeed(effectiveSeed, `js.${cli}` as "js.npm" | "js.npx");
    const cliPath = findCli(executableCandidates, cli, options);
    if (!cliPath) {
      pairedCandidates.push(
        candidateFromSeed(cliSeed, {
          executable,
          health: "incomplete",
          reasonCode: "TOOLCHAIN_INCOMPLETE",
          componentRoot,
        }),
      );
      continue;
    }

    const cliResult = await options.executor.run({
      executable,
      args: [cliPath, "--version"],
      env,
    });
    if (!probeSucceeded(cliResult)) {
      pairedCandidates.push(
        candidateFromSeed(cliSeed, {
          executable,
          argvPrefix: [cliPath],
          health: "incomplete",
          reasonCode: "TOOLCHAIN_INCOMPLETE",
          componentRoot,
        }),
      );
      continue;
    }

    pairedCandidates.push(
      candidateFromSeed(cliSeed, {
        executable,
        argvPrefix: [cliPath],
        version: cliResult.stdout.trim().split(/\s+/)[0],
        componentRoot,
        ...versionHealth,
      }),
    );
  }

  return pairedCandidates;
}
