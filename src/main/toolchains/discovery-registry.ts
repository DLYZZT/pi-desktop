import fs from "node:fs";
import path from "node:path";
import type { ManagedComponentId, ToolCapabilityId, ToolProvider } from "../../shared/toolchains/types";
import { normalizePathEntries, normalizeToolPath, toolPathComparisonKey } from "./candidate-normalizer.ts";
import { defaultProbeExecutor, type ProbeExecutor } from "./process-runner.ts";

const MAX_ENUMERATED_CHILDREN = 64;
const MAX_SEEDS = 320;

export interface DiscoveryFileSystem {
  isFile(filePath: string): boolean;
  isDirectory(directoryPath: string): boolean;
  readDirectoryNames(directoryPath: string): string[];
  realpath(filePath: string): string;
}

export const nodeDiscoveryFileSystem: DiscoveryFileSystem = {
  isFile(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  isDirectory(directoryPath) {
    try {
      return fs.statSync(directoryPath).isDirectory();
    } catch {
      return false;
    }
  },
  readDirectoryNames(directoryPath) {
    try {
      return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"))
        .slice(0, MAX_ENUMERATED_CHILDREN);
    } catch {
      return [];
    }
  },
  realpath(filePath) {
    try {
      return fs.realpathSync.native(filePath);
    } catch {
      return filePath;
    }
  },
};

export interface ExecutableSeed {
  capability: ToolCapabilityId;
  provider: ToolProvider;
  discovery: string;
  executable: string;
  argvPrefix: string[];
  binDir: string;
  rank: number;
  pathOrder?: number;
  componentId?: ManagedComponentId;
  componentRoot?: string;
}

interface BinDirectorySeed {
  directory: string;
  discovery: string;
  rank: number;
  pathOrder?: number;
}

export interface DiscoveryRegistryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileSystem?: DiscoveryFileSystem;
  executor?: ProbeExecutor;
  includeWindowsCommandDiscovery?: boolean;
  legacyNpmCommand?: readonly string[];
}

const POSIX_TOOL_NAMES: ReadonlyArray<readonly [ToolCapabilityId, readonly string[]]> = [
  ["shell.bash", ["bash"]],
  ["shell.powershell", ["pwsh"]],
  ["vcs.git", ["git"]],
  ["js.node", ["node"]],
  ["js.bun", ["bun"]],
  ["python.interpreter", ["python3", "python"]],
  ["python.uv", ["uv"]],
  ["python.uvx", ["uvx"]],
  ["search.rg", ["rg"]],
  ["search.fd", ["fd", "fdfind"]],
  ["data.jq", ["jq"]],
  ["network.curl", ["curl"]],
];

const WINDOWS_TOOL_NAMES: ReadonlyArray<readonly [ToolCapabilityId, readonly string[]]> = [
  ["shell.bash", ["bash.exe"]],
  ["shell.powershell", ["pwsh.exe", "powershell.exe"]],
  ["vcs.git", ["git.exe"]],
  ["js.node", ["node.exe"]],
  ["js.bun", ["bun.exe"]],
  ["python.interpreter", ["python.exe", "python3.exe"]],
  ["python.uv", ["uv.exe"]],
  ["python.uvx", ["uvx.exe"]],
  ["search.rg", ["rg.exe"]],
  ["search.fd", ["fd.exe", "fdfind.exe"]],
  ["data.jq", ["jq.exe"]],
  ["network.curl", ["curl.exe"]],
];

function platformPath(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

function executableCapability(filePath: string, platform: NodeJS.Platform): ToolCapabilityId | undefined {
  const basename = platformPath(platform)
    .basename(filePath)
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/i, "");
  if (basename === "bash") return "shell.bash";
  if (basename === "pwsh" || basename === "powershell") return "shell.powershell";
  if (basename === "git") return "vcs.git";
  if (basename === "node") return "js.node";
  if (basename === "bun") return "js.bun";
  if (/^python(?:3(?:\.\d+)?)?$/.test(basename)) return "python.interpreter";
  if (basename === "uv") return "python.uv";
  if (basename === "uvx") return "python.uvx";
  if (basename === "rg") return "search.rg";
  if (basename === "fd" || basename === "fdfind") return "search.fd";
  if (basename === "jq") return "data.jq";
  if (basename === "curl") return "network.curl";
  return undefined;
}

export function parsePythonLauncherPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/((?:[A-Za-z]:\\|\\\\)[^\r\n]*?python(?:3(?:\.\d+)?)?\.exe)\s*$/i);
    if (match?.[1]) paths.push(match[1].trim());
  }
  return paths;
}

export function parsePep514ExecutablePaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/ExecutablePath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+python(?:3(?:\.\d+)?)?\.exe)\s*$/i);
    if (match?.[1]) paths.push(match[1].trim().replace(/^"|"$/g, ""));
  }
  return paths;
}

export class DiscoveryRegistry {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly fileSystem: DiscoveryFileSystem;
  readonly executor: ProbeExecutor;
  readonly includeWindowsCommandDiscovery: boolean;
  readonly legacyNpmCommand?: readonly string[];

  constructor(options: DiscoveryRegistryOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = { ...(options.env ?? process.env) };
    this.homeDir =
      options.homeDir ?? envValue(this.env, this.platform === "win32" ? "USERPROFILE" : "HOME", this.platform) ?? "";
    this.fileSystem = options.fileSystem ?? nodeDiscoveryFileSystem;
    this.executor = options.executor ?? defaultProbeExecutor;
    this.includeWindowsCommandDiscovery = options.includeWindowsCommandDiscovery ?? true;
    this.legacyNpmCommand = options.legacyNpmCommand ? [...options.legacyNpmCommand] : undefined;
  }

  async collect(): Promise<ExecutableSeed[]> {
    const directories = this.collectBinDirectories();
    const seeds: ExecutableSeed[] = [];
    const seen = new Set<string>();

    const addSeed = (
      capability: ToolCapabilityId,
      executable: string,
      discovery: string,
      rank: number,
      pathOrder?: number,
    ): void => {
      if (seeds.length >= MAX_SEEDS) return;
      const normalized = normalizeToolPath(executable, this.platform);
      if (!normalized || !this.fileSystem.isFile(normalized)) return;
      const key = `${capability}\0${toolPathComparisonKey(normalized, this.platform)}`;
      if (seen.has(key)) return;
      seen.add(key);
      seeds.push({
        capability,
        provider: "system",
        discovery,
        executable: normalized,
        argvPrefix: [],
        binDir: platformPath(this.platform).dirname(normalized),
        rank,
        pathOrder,
      });
    };

    const toolNames = this.platform === "win32" ? WINDOWS_TOOL_NAMES : POSIX_TOOL_NAMES;
    for (const directory of directories) {
      for (const [capability, names] of toolNames) {
        for (const name of names) {
          addSeed(
            capability,
            platformPath(this.platform).join(directory.directory, name),
            directory.discovery,
            directory.rank,
            directory.pathOrder,
          );
        }
      }
    }

    if (this.platform === "win32" && this.includeWindowsCommandDiscovery) {
      await this.collectWindowsCommandCandidates(addSeed);
    }

    const legacyNpmSeed = this.resolveLegacyNpmCommand(directories);
    if (legacyNpmSeed && seeds.length < MAX_SEEDS) seeds.push(legacyNpmSeed);

    return seeds;
  }

  private resolveLegacyNpmCommand(directories: readonly BinDirectorySeed[]): ExecutableSeed | undefined {
    const command = this.legacyNpmCommand;
    if (!command?.length) return undefined;
    const pathApi = platformPath(this.platform);
    const requested = normalizeToolPath(command[0]!, this.platform);
    if (!requested || /[\0\r\n]/.test(requested)) return undefined;

    const executableNames = [requested];
    if (this.platform === "win32" && !pathApi.extname(requested)) {
      executableNames.push(`${requested}.exe`, `${requested}.cmd`, `${requested}.bat`);
    }
    const candidates = pathApi.isAbsolute(requested)
      ? executableNames
      : requested === pathApi.basename(requested)
        ? directories.flatMap((directory) => executableNames.map((name) => pathApi.join(directory.directory, name)))
        : [];
    const executable = candidates
      .map((candidate) => normalizeToolPath(candidate, this.platform))
      .find((candidate) => candidate && this.fileSystem.isFile(candidate));
    if (!executable) return undefined;
    return {
      capability: "js.npm",
      provider: "custom",
      discovery: "legacy-npm-command",
      executable,
      argvPrefix: command.slice(1),
      binDir: pathApi.dirname(executable),
      rank: 50,
    };
  }

  collectBinDirectories(): BinDirectorySeed[] {
    const pathApi = platformPath(this.platform);
    const directories: BinDirectorySeed[] = [];
    const seen = new Set<string>();
    const add = (directory: string | undefined, discovery: string, rank: number, pathOrder?: number): void => {
      if (!directory) return;
      const normalized = normalizeToolPath(directory, this.platform);
      if (!normalized) return;
      const key = toolPathComparisonKey(normalized, this.platform);
      if (seen.has(key)) return;
      seen.add(key);
      directories.push({ directory: normalized, discovery, rank, pathOrder });
    };
    const enumerate = (
      root: string,
      mapChild: (rootPath: string, child: string) => string,
      discovery: string,
      rank: number,
      filter?: (name: string) => boolean,
    ): void => {
      for (const child of this.fileSystem.readDirectoryNames(root).slice(0, MAX_ENUMERATED_CHILDREN)) {
        if (filter && !filter(child)) continue;
        add(mapChild(root, child), `${discovery}:${child}`, rank);
      }
    };

    const pathText = envValue(this.env, "PATH", this.platform) ?? "";
    const pathEntries = normalizePathEntries(pathText, this.platform);
    pathEntries.forEach((entry, index) => add(entry, "path", 100 + index, index));

    if (this.platform === "win32") {
      const programFiles = envValue(this.env, "ProgramFiles", this.platform) ?? "C:\\Program Files";
      const localAppData = envValue(this.env, "LOCALAPPDATA", this.platform);
      const appData = envValue(this.env, "APPDATA", this.platform);
      const userProfile = this.homeDir || envValue(this.env, "USERPROFILE", this.platform);
      const voltaHome = envValue(this.env, "VOLTA_HOME", this.platform);
      const condaPrefix = envValue(this.env, "CONDA_PREFIX", this.platform);
      const miseData = envValue(this.env, "MISE_DATA_DIR", this.platform);
      const fnmRoot =
        envValue(this.env, "FNM_DIR", this.platform) ?? (appData ? pathApi.join(appData, "fnm") : undefined);

      add(pathApi.join(programFiles, "nodejs"), "windows-program-files-node", 1_000);
      add(localAppData ? pathApi.join(localAppData, "Programs", "nodejs") : undefined, "windows-local-node", 1_010);
      add(pathApi.join(programFiles, "PowerShell", "7"), "windows-powershell", 1_011);
      add(
        pathApi.join(
          envValue(this.env, "SystemRoot", this.platform) ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
        ),
        "windows-powershell-inbox",
        1_012,
      );
      add(envValue(this.env, "NVM_SYMLINK", this.platform), "nvm-windows-symlink", 1_020);
      add(envValue(this.env, "NVM_HOME", this.platform), "nvm-windows-home", 1_021);
      add(voltaHome ? pathApi.join(voltaHome, "bin") : undefined, "volta", 1_030);
      add(userProfile ? pathApi.join(userProfile, ".volta", "bin") : undefined, "volta-home", 1_031);
      add(userProfile ? pathApi.join(userProfile, ".bun", "bin") : undefined, "bun-home", 1_032);
      add(miseData ? pathApi.join(miseData, "shims") : undefined, "mise", 1_034);
      add(localAppData ? pathApi.join(localAppData, "mise", "shims") : undefined, "mise-local", 1_035);
      add(userProfile ? pathApi.join(userProfile, ".local", "share", "mise", "shims") : undefined, "mise-home", 1_036);
      add(
        envValue(this.env, "FNM_MULTISHELL_PATH", this.platform)
          ? pathApi.join(envValue(this.env, "FNM_MULTISHELL_PATH", this.platform)!, "bin")
          : undefined,
        "fnm-multishell",
        1_033,
      );
      add(pathApi.join(programFiles, "Git", "cmd"), "git-for-windows", 1_040);
      add(pathApi.join(programFiles, "Git", "bin"), "git-for-windows", 1_041);
      add(
        localAppData ? pathApi.join(localAppData, "Programs", "Git", "cmd") : undefined,
        "git-for-windows-local",
        1_042,
      );
      add(
        localAppData ? pathApi.join(localAppData, "Programs", "Git", "bin") : undefined,
        "git-for-windows-local",
        1_043,
      );
      add(userProfile ? pathApi.join(userProfile, ".local", "bin") : undefined, "user-local", 1_050);

      if (localAppData) {
        const pythonRoot = pathApi.join(localAppData, "Programs", "Python");
        enumerate(
          pythonRoot,
          (root, child) => pathApi.join(root, child),
          "python-official",
          1_060,
          (name) => /^Python\d+/i.test(name),
        );
        enumerate(
          pythonRoot,
          (root, child) => pathApi.join(root, child, "Scripts"),
          "python-official-scripts",
          1_061,
          (name) => /^Python\d+/i.test(name),
        );
      }

      if (userProfile) {
        const scoopRoot = pathApi.join(userProfile, "scoop", "apps");
        for (const packageName of ["nodejs", "nodejs-lts", "git", "python", "uv", "ripgrep", "fd", "jq", "bun"]) {
          add(pathApi.join(scoopRoot, packageName, "current"), `scoop:${packageName}`, 1_100);
          add(pathApi.join(scoopRoot, packageName, "current", "bin"), `scoop:${packageName}`, 1_101);
        }
        const pyenvVersions = pathApi.join(userProfile, ".pyenv", "pyenv-win", "versions");
        enumerate(pyenvVersions, (root, child) => pathApi.join(root, child), "pyenv-win", 1_120);
        enumerate(pyenvVersions, (root, child) => pathApi.join(root, child, "Scripts"), "pyenv-win-scripts", 1_121);
        for (const distribution of ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]) {
          const distributionRoot = pathApi.join(userProfile, distribution);
          add(distributionRoot, `conda-known:${distribution}`, 1_122);
          add(pathApi.join(distributionRoot, "Scripts"), `conda-known:${distribution}`, 1_123);
          add(pathApi.join(distributionRoot, "Library", "bin"), `conda-known:${distribution}`, 1_124);
        }
      }

      if (fnmRoot) {
        const versions = pathApi.join(fnmRoot, "node-versions");
        enumerate(versions, (root, child) => pathApi.join(root, child, "installation"), "fnm", 1_125);
        enumerate(versions, (root, child) => pathApi.join(root, child, "installation", "bin"), "fnm", 1_126);
      }

      add(condaPrefix, "conda", 1_130);
      add(condaPrefix ? pathApi.join(condaPrefix, "Scripts") : undefined, "conda-scripts", 1_131);
      add(condaPrefix ? pathApi.join(condaPrefix, "Library", "bin") : undefined, "conda-library", 1_132);
    } else {
      add("/usr/local/bin", "posix-known", 1_000);
      add("/usr/bin", "posix-known", 1_001);
      add("/bin", "posix-known", 1_002);
      add(this.homeDir ? pathApi.join(this.homeDir, ".local", "bin") : undefined, "user-local", 1_010);
      add(this.homeDir ? pathApi.join(this.homeDir, ".volta", "bin") : undefined, "volta", 1_020);
      add(this.homeDir ? pathApi.join(this.homeDir, ".local", "share", "mise", "shims") : undefined, "mise", 1_021);
      add(this.homeDir ? pathApi.join(this.homeDir, ".asdf", "shims") : undefined, "asdf", 1_022);
      add(this.homeDir ? pathApi.join(this.homeDir, ".bun", "bin") : undefined, "bun-home", 1_023);
      add(
        envValue(this.env, "CONDA_PREFIX", this.platform)
          ? pathApi.join(envValue(this.env, "CONDA_PREFIX", this.platform)!, "bin")
          : undefined,
        "conda",
        1_024,
      );
      add(
        envValue(this.env, "FNM_MULTISHELL_PATH", this.platform)
          ? pathApi.join(envValue(this.env, "FNM_MULTISHELL_PATH", this.platform)!, "bin")
          : undefined,
        "fnm-multishell",
        1_025,
      );

      if (this.homeDir) {
        for (const distribution of ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]) {
          add(pathApi.join(this.homeDir, distribution, "bin"), `conda-known:${distribution}`, 1_026);
        }
      }

      if (this.platform === "darwin") {
        add("/opt/homebrew/bin", "homebrew", 1_030);
        add("/usr/local/microsoft/powershell/7", "powershell", 1_030);
        const brewRoots = ["/opt/homebrew/opt", "/usr/local/opt"];
        for (const root of brewRoots) {
          enumerate(
            root,
            (rootPath, child) => pathApi.join(rootPath, child, "bin"),
            "homebrew-formula",
            1_031,
            (name) => /^(?:node(?:@\d+)?|python(?:@\d+(?:\.\d+)?)?)$/.test(name),
          );
        }
        enumerate(
          "/Library/Frameworks/Python.framework/Versions",
          (root, child) => pathApi.join(root, child, "bin"),
          "python-org-framework",
          1_032,
          (name) => /^\d+(?:\.\d+){0,2}$/.test(name),
        );
      } else if (this.platform === "linux") {
        add("/home/linuxbrew/.linuxbrew/bin", "linuxbrew", 1_030);
        add("/opt/microsoft/powershell/7", "powershell", 1_031);
      }

      if (this.homeDir) {
        enumerate(
          pathApi.join(this.homeDir, ".nvm", "versions", "node"),
          (root, child) => pathApi.join(root, child, "bin"),
          "nvm",
          1_100,
        );
        const defaultFnmRoot =
          this.platform === "darwin"
            ? pathApi.join(this.homeDir, "Library", "Application Support", "fnm")
            : pathApi.join(this.homeDir, ".local", "share", "fnm");
        const fnmRoot = envValue(this.env, "FNM_DIR", this.platform) ?? defaultFnmRoot;
        enumerate(
          pathApi.join(fnmRoot, "node-versions"),
          (root, child) => pathApi.join(root, child, "installation", "bin"),
          "fnm",
          1_110,
        );
        enumerate(
          pathApi.join(this.homeDir, ".pyenv", "versions"),
          (root, child) => pathApi.join(root, child, "bin"),
          "pyenv",
          1_120,
        );
      }
    }

    return directories;
  }

  private async collectWindowsCommandCandidates(
    addSeed: (
      capability: ToolCapabilityId,
      executable: string,
      discovery: string,
      rank: number,
      pathOrder?: number,
    ) => void,
  ): Promise<void> {
    const pathApi = path.win32;
    const systemRoot = envValue(this.env, "SystemRoot", this.platform) ?? "C:\\Windows";
    const whereExecutable = pathApi.join(systemRoot, "System32", "where.exe");
    const regExecutable = pathApi.join(systemRoot, "System32", "reg.exe");
    const localAppData = envValue(this.env, "LOCALAPPDATA", this.platform);
    let pythonLauncher = [
      localAppData ? pathApi.join(localAppData, "Programs", "Python", "Launcher", "py.exe") : undefined,
      pathApi.join(systemRoot, "py.exe"),
    ].find((candidate): candidate is string => Boolean(candidate && this.fileSystem.isFile(candidate)));

    if (this.fileSystem.isFile(whereExecutable)) {
      const whereResult = await this.executor.run({
        executable: whereExecutable,
        args: [
          "node.exe",
          "git.exe",
          "bash.exe",
          "python.exe",
          "python3.exe",
          "py.exe",
          "uv.exe",
          "uvx.exe",
          "rg.exe",
          "fd.exe",
          "jq.exe",
          "bun.exe",
          "pwsh.exe",
          "curl.exe",
        ],
        env: this.env,
      });
      for (const line of whereResult.stdout.split(/\r?\n/)) {
        const executable = normalizeToolPath(line.trim(), this.platform);
        if (!executable || !this.fileSystem.isFile(executable)) continue;
        if (pathApi.basename(executable).toLowerCase() === "py.exe") {
          pythonLauncher ??= executable;
          continue;
        }
        const capability = executableCapability(executable, this.platform);
        if (capability) addSeed(capability, executable, "where.exe", 1_300);
      }
    }

    if (pythonLauncher) {
      const launcherResult = await this.executor.run({
        executable: pythonLauncher,
        args: ["--list-paths"],
        env: this.env,
      });
      for (const executable of parsePythonLauncherPaths(launcherResult.stdout)) {
        addSeed("python.interpreter", executable, "python-launcher", 1_310);
      }
    }

    if (this.fileSystem.isFile(regExecutable)) {
      for (const registryRoot of [
        "HKCU\\Software\\Python\\PythonCore",
        "HKLM\\Software\\Python\\PythonCore",
        "HKLM\\Software\\WOW6432Node\\Python\\PythonCore",
      ]) {
        const registryResult = await this.executor.run({
          executable: regExecutable,
          args: ["query", registryRoot, "/s", "/v", "ExecutablePath"],
          env: this.env,
        });
        for (const executable of parsePep514ExecutablePaths(registryResult.stdout)) {
          addSeed("python.interpreter", executable, "pep-514", 1_320);
        }
      }
    }
  }
}
