import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCandidate, ToolHealth, ToolchainErrorCode } from "../../../shared/toolchains/types";
import type { DiscoveryFileSystem, ExecutableSeed } from "../discovery-registry.ts";
import { normalizeToolPath } from "../candidate-normalizer.ts";
import type { ProbeExecutor, ProbeResult } from "../process-runner.ts";
import { probeSucceeded } from "../process-runner.ts";
import { buildProbeEnvironment, candidateFromSeed, failedCandidate, firstVersion } from "./common.ts";
import { probeNodeDistribution } from "./node.ts";

export interface CapabilityProbeOptions {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  tempRoot?: string;
  fileSystem: DiscoveryFileSystem;
  executor: ProbeExecutor;
}

function versionCandidate(seed: ExecutableSeed, output: string): ToolCandidate {
  return candidateFromSeed(seed, { version: firstVersion(output) });
}

function versionCandidateWithMaximumMajor(seed: ExecutableSeed, output: string, maximumMajor: number): ToolCandidate {
  const version = firstVersion(output);
  const major = Number.parseInt(version?.split(".")[0] ?? "", 10);
  if (Number.isSafeInteger(major) && major > maximumMajor) {
    return candidateFromSeed(seed, {
      version,
      health: "unverified",
      reasonCode: "TOOLCHAIN_UNVERIFIED",
    });
  }
  return candidateFromSeed(seed, { version });
}

async function run(
  seed: ExecutableSeed,
  options: CapabilityProbeOptions,
  args: string[],
  extra: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProbeResult> {
  return options.executor.run({
    executable: seed.executable,
    args: [...seed.argvPrefix, ...args],
    cwd: extra.cwd,
    input: extra.input,
    env: buildProbeEnvironment(options.env, seed.binDir, options.platform, extra.env),
  });
}

async function withProbeDirectory<T>(
  tempRoot: string | undefined,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const root = tempRoot ?? os.tmpdir();
  const directory = fs.mkdtempSync(path.join(root, "pi-toolchain-probe-"));
  try {
    return await operation(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function probeBash(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  return withProbeDirectory(options.tempRoot, async (directory) => {
    const sentinel = "PI_TOOLCHAIN_BASH_OK";
    const result = await run(seed, options, ["--noprofile", "--norc", "-c", `printf '%s\\n' '${sentinel}'; pwd`], {
      cwd: directory,
    });
    if (!probeSucceeded(result) || !result.stdout.includes(sentinel)) return failedCandidate(seed, result);
    if (
      options.platform === "win32" &&
      !/(?:[\\/](?:Git|PortableGit)[\\/]|[\\/]scoop[\\/]apps[\\/]git[\\/])/i.test(seed.executable)
    ) {
      return candidateFromSeed(seed, {
        version: firstVersion(versionResult.stdout || versionResult.stderr),
        health: "unverified",
        reasonCode: "TOOLCHAIN_UNVERIFIED",
      });
    }
    return versionCandidate(seed, versionResult.stdout || versionResult.stderr);
  });
}

async function probePowerShell(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const sentinel = "PI_TOOLCHAIN_POWERSHELL_OK";
  const result = await run(seed, options, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Write-Output '${sentinel}'; $PSVersionTable.PSVersion.ToString()`,
  ]);
  if (!probeSucceeded(result) || !result.stdout.includes(sentinel)) return failedCandidate(seed, result);
  return versionCandidate(seed, result.stdout);
}

async function probeGit(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  return withProbeDirectory(options.tempRoot, async (directory) => {
    for (const args of [
      ["-c", "init.defaultBranch=main", "init", "--quiet"],
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain=v1"],
      ["worktree", "list", "--porcelain"],
    ]) {
      const result = await run(seed, options, args, { cwd: directory });
      if (!probeSucceeded(result)) return failedCandidate(seed, result);
      if (args[0] === "rev-parse" && !result.stdout.includes("true")) return failedCandidate(seed, result);
    }
    return versionCandidate(seed, versionResult.stdout);
  });
}

interface PythonPayload {
  executable?: string;
  version?: string;
  implementation?: string;
  prefix?: string;
  platform?: string;
  machine?: string;
}

function pythonHealth(payload: PythonPayload): { health: ToolHealth; reasonCode?: ToolchainErrorCode } {
  const version = payload.version ?? "0";
  const [major, minor] = version.split(".").map((value) => Number.parseInt(value, 10));
  if (payload.implementation !== "cpython" || major !== 3 || (minor ?? 0) < 10) {
    return { health: "unsupported", reasonCode: "TOOLCHAIN_UNSUPPORTED" };
  }
  if ((minor ?? 0) > 14) return { health: "unverified", reasonCode: "TOOLCHAIN_UNVERIFIED" };
  return { health: "healthy" };
}

async function probePython(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const result = await run(seed, options, [
    "-I",
    "-S",
    "-c",
    "import json,platform,sys; print(json.dumps({'executable':sys.executable,'version':platform.python_version(),'implementation':sys.implementation.name,'prefix':sys.prefix,'platform':sys.platform,'machine':platform.machine()}))",
  ]);
  if (!probeSucceeded(result)) return failedCandidate(seed, result);
  try {
    const payload = JSON.parse(result.stdout.trim()) as PythonPayload;
    const architecture = normalizeMachineArchitecture(payload.machine);
    if (!payload.version || !payload.executable || payload.platform !== options.platform || !architecture) {
      return failedCandidate(seed, result);
    }
    const isRosettaCandidate =
      options.platform === "darwin" &&
      options.arch === "arm64" &&
      architecture === "x64" &&
      (seed.provider === "system" || seed.provider === "custom");
    if (architecture !== options.arch && !isRosettaCandidate) return failedCandidate(seed, result);
    const effectiveSeed = isRosettaCandidate ? { ...seed, rank: seed.rank + 10_000 } : seed;
    const reportedExecutable = normalizeToolPath(payload.executable, options.platform);
    const executable =
      reportedExecutable && options.fileSystem.isFile(reportedExecutable) ? reportedExecutable : seed.executable;
    return candidateFromSeed(effectiveSeed, { executable, version: payload.version, ...pythonHealth(payload) });
  } catch {
    return failedCandidate(seed, result);
  }
}

function normalizeMachineArchitecture(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64" || normalized === "x64") return "x64";
  if (normalized === "aarch64" || normalized === "arm64") return "arm64";
  return normalized || undefined;
}

async function probeRg(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  return withProbeDirectory(options.tempRoot, async (directory) => {
    const file = path.join(directory, "文本 with spaces.txt");
    fs.writeFileSync(file, "PI_TOOLCHAIN_RG_OK\n", "utf8");
    const result = await run(seed, options, ["--fixed-strings", "--line-number", "PI_TOOLCHAIN_RG_OK", file], {
      cwd: directory,
    });
    if (!probeSucceeded(result) || !result.stdout.includes("PI_TOOLCHAIN_RG_OK")) return failedCandidate(seed, result);
    return versionCandidate(seed, versionResult.stdout);
  });
}

async function probeFd(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  return withProbeDirectory(options.tempRoot, async (directory) => {
    fs.writeFileSync(path.join(directory, "pi-toolchain-fd-probe.txt"), "ok", "utf8");
    const result = await run(seed, options, ["--hidden", "--type", "f", "--glob", "pi-toolchain-fd-probe.txt", "."], {
      cwd: directory,
    });
    if (!probeSucceeded(result) || !result.stdout.includes("pi-toolchain-fd-probe.txt")) {
      return failedCandidate(seed, result);
    }
    return versionCandidate(seed, versionResult.stdout);
  });
}

async function probeJq(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  const result = await run(seed, options, ["-c", ".pi"], { input: '{"pi":"PI_TOOLCHAIN_JQ_OK"}\n' });
  if (!probeSucceeded(result) || !result.stdout.includes("PI_TOOLCHAIN_JQ_OK")) return failedCandidate(seed, result);
  return versionCandidate(seed, versionResult.stdout || versionResult.stderr);
}

async function probeBun(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const versionResult = await run(seed, options, ["--version"]);
  if (!probeSucceeded(versionResult)) return failedCandidate(seed, versionResult);
  const result = await run(seed, options, ["-e", "process.stdout.write('PI_TOOLCHAIN_BUN_OK')"]);
  if (!probeSucceeded(result) || result.stdout !== "PI_TOOLCHAIN_BUN_OK") return failedCandidate(seed, result);
  return versionCandidateWithMaximumMajor(seed, versionResult.stdout, 1);
}

async function probeVersionOnly(seed: ExecutableSeed, options: CapabilityProbeOptions): Promise<ToolCandidate> {
  const result = await run(seed, options, ["--version"]);
  if (!probeSucceeded(result)) return failedCandidate(seed, result);
  return versionCandidate(seed, result.stdout || result.stderr);
}

export async function probeExecutableSeed(
  seed: ExecutableSeed,
  options: CapabilityProbeOptions,
): Promise<ToolCandidate[]> {
  if (seed.capability === "js.node") {
    return probeNodeDistribution(seed, options);
  }

  let candidate: ToolCandidate;
  switch (seed.capability) {
    case "shell.bash":
      candidate = await probeBash(seed, options);
      break;
    case "shell.powershell":
      candidate = await probePowerShell(seed, options);
      break;
    case "vcs.git":
      candidate = await probeGit(seed, options);
      break;
    case "python.interpreter":
      candidate = await probePython(seed, options);
      break;
    case "search.rg":
      candidate = await probeRg(seed, options);
      break;
    case "search.fd":
      candidate = await probeFd(seed, options);
      break;
    case "data.jq":
      candidate = await probeJq(seed, options);
      break;
    case "js.bun":
      candidate = await probeBun(seed, options);
      break;
    default:
      candidate = await probeVersionOnly(seed, options);
      break;
  }

  if (seed.capability === "python.uv" && candidate.health === "healthy") {
    const uvxSeed: ExecutableSeed = { ...seed, capability: "python.uvx", argvPrefix: ["tool", "run"] };
    return [candidate, candidateFromSeed(uvxSeed, { version: candidate.version })];
  }
  return [candidate];
}
