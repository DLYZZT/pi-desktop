import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HERDR_AGENT_CLI_CATALOG, type AgentCliCatalogEntry } from "../../shared/herdr/agent-cli-catalog.ts";
import type { HerdrAgentCliDiagnostic, HerdrAgentCliSource, HerdrStartableAgentKind } from "../../contract/herdr.ts";

const MAX_DIRECTORIES = 256;
const MAX_CANDIDATES_PER_KIND = 32;
const MAX_ENUMERATED_CHILDREN = 128;
const MAX_PATH_LENGTH = 4_096;

type DirectorySeed = {
  directory: string;
  source: HerdrAgentCliSource;
  precedence: number;
};

export type HerdrAgentCliCandidate = {
  kind: HerdrStartableAgentKind;
  executable: string;
  realExecutable: string;
  directory: string;
  source: HerdrAgentCliSource;
  launchForm: "native" | "posix-script" | "windows-cmd";
  precedence: number;
};

export type HerdrAgentCliDiscoverySnapshot = {
  revision: number;
  generatedAt: number;
  selected: ReadonlyMap<HerdrStartableAgentKind, HerdrAgentCliCandidate | undefined>;
  candidates: ReadonlyMap<HerdrStartableAgentKind, readonly HerdrAgentCliCandidate[]>;
  diagnostics: readonly HerdrAgentCliDiagnostic[];
  overlayDirectory: string;
  managedPath: string;
};

export type HerdrAgentCliDiscoveryOptions = {
  homeDir: string;
  userDataDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const actual = Object.keys(env).find((candidate) => candidate.toLocaleLowerCase("en-US") === key.toLowerCase());
  return actual ? env[actual] : undefined;
}

function safeDirectory(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (!value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(value)) return undefined;
  const pathApi = platformPath(platform);
  if (!pathApi.isAbsolute(value)) return undefined;
  return pathApi.normalize(value);
}

function sourceForDirectory(
  directory: string,
  fallback: HerdrAgentCliSource,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): HerdrAgentCliSource {
  const key = pathKey(directory, platform);
  const matches = (candidate: string | undefined): boolean => {
    const safe = safeDirectory(candidate, platform);
    return Boolean(safe && pathKey(safe, platform) === key);
  };
  if (matches("/opt/homebrew/bin") || matches("/home/linuxbrew/.linuxbrew/bin")) return "homebrew";
  if (matches("/opt/local/bin")) return "macports";
  if (matches("/usr/bin") || matches("/bin")) return "system";
  if (matches(envValue(env, "UV_TOOL_BIN_DIR", platform)) || matches(envValue(env, "XDG_BIN_HOME", platform))) {
    return "uv";
  }
  if (matches(envValue(env, "BUN_INSTALL", platform))) return "bun";
  if (matches(envValue(env, "PNPM_HOME", platform))) return "version-manager";
  const lower = directory.replace(/\\/g, "/").toLowerCase();
  if (lower.endsWith("/.bun/bin")) return "bun";
  if (lower.endsWith("/appdata/roaming/npm")) return "npm";
  if (lower.includes("/microsoft/winget/links") || lower.includes("/microsoft/windowsapps")) return "winget";
  if (lower.includes("/.nvm/") || lower.includes("/fnm/") || lower.includes("/.volta/") || lower.includes("/mise/")) {
    return "version-manager";
  }
  return fallback;
}

function addDirectorySeed(
  seeds: DirectorySeed[],
  seen: Set<string>,
  directory: string | undefined,
  source: HerdrAgentCliSource,
  precedence: number,
  platform: NodeJS.Platform,
): void {
  if (seeds.length >= MAX_DIRECTORIES) return;
  const normalized = safeDirectory(directory, platform);
  if (!normalized) return;
  const key = pathKey(normalized, platform);
  if (seen.has(key)) return;
  seen.add(key);
  seeds.push({ directory: normalized, source, precedence });
}

async function addVersionManagerDirectories(
  seeds: DirectorySeed[],
  seen: Set<string>,
  root: string,
  suffix: readonly string[],
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32" || seeds.length >= MAX_DIRECTORIES) return;
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const pathApi = platformPath(platform);
  for (const child of children.slice(0, MAX_ENUMERATED_CHILDREN)) {
    if (!child.isDirectory()) continue;
    addDirectorySeed(seeds, seen, pathApi.join(root, child.name, ...suffix), "version-manager", 2_500, platform);
  }
}

export async function collectAgentCliDirectorySeeds(
  options: Pick<HerdrAgentCliDiscoveryOptions, "homeDir" | "platform" | "env">,
): Promise<readonly DirectorySeed[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platformPath(platform);
  const homeDir = safeDirectory(options.homeDir, platform);
  if (!homeDir) throw new Error("Agent CLI discovery home directory must be absolute");
  const seeds: DirectorySeed[] = [];
  const seen = new Set<string>();
  const delimiter = pathDelimiter(platform);
  const inheritedPath = envValue(env, "PATH", platform) ?? "";
  inheritedPath.split(delimiter).forEach((directory, index) => {
    addDirectorySeed(
      seeds,
      seen,
      directory,
      sourceForDirectory(directory, "path", platform, env),
      100 + index,
      platform,
    );
  });

  if (platform === "win32") {
    const localAppData =
      safeDirectory(envValue(env, "LOCALAPPDATA", platform), platform) ?? pathApi.join(homeDir, "AppData", "Local");
    const appData =
      safeDirectory(envValue(env, "APPDATA", platform), platform) ?? pathApi.join(homeDir, "AppData", "Roaming");
    const programData = safeDirectory(envValue(env, "PROGRAMDATA", platform), platform);
    const windowsDirectories: Array<[string | undefined, HerdrAgentCliSource]> = [
      [pathApi.join(homeDir, ".local", "bin"), "official"],
      [pathApi.join(homeDir, ".grok", "bin"), "official"],
      [pathApi.join(homeDir, ".opencode", "bin"), "official"],
      [pathApi.join(homeDir, "bin"), "official"],
      [pathApi.join(localAppData, "omp"), "official"],
      [pathApi.join(localAppData, "qwen-code", "bin"), "official"],
      [pathApi.join(localAppData, "Programs", "OpenAI", "Codex", "bin"), "official"],
      [pathApi.join(appData, "npm"), "npm"],
      [pathApi.join(homeDir, ".bun", "bin"), "bun"],
      [envValue(env, "PNPM_HOME", platform), "version-manager"],
      [pathApi.join(localAppData, "pnpm"), "version-manager"],
      [pathApi.join(localAppData, "Microsoft", "WinGet", "Links"), "winget"],
      [pathApi.join(localAppData, "Microsoft", "WindowsApps"), "winget"],
      [envValue(env, "UV_TOOL_BIN_DIR", platform), "uv"],
      [envValue(env, "XDG_BIN_HOME", platform), "uv"],
      [
        envValue(env, "VOLTA_HOME", platform) ? pathApi.join(envValue(env, "VOLTA_HOME", platform)!, "bin") : undefined,
        "version-manager",
      ],
      [programData ? pathApi.join(programData, "chocolatey", "bin") : undefined, "version-manager"],
    ];
    windowsDirectories.forEach(([directory, source], index) =>
      addDirectorySeed(seeds, seen, directory, source, 1_000 + index, platform),
    );
  } else {
    const posixDirectories: Array<[string | undefined, HerdrAgentCliSource]> = [
      [pathApi.join(homeDir, ".local", "bin"), "official"],
      [pathApi.join(homeDir, ".pi", "agent", "bin"), "official"],
      [pathApi.join(homeDir, ".opencode", "bin"), "official"],
      [pathApi.join(homeDir, ".grok", "bin"), "official"],
      [pathApi.join(homeDir, ".bun", "bin"), "bun"],
      [pathApi.join(homeDir, ".yarn", "bin"), "version-manager"],
      [pathApi.join(homeDir, ".volta", "bin"), "version-manager"],
      [pathApi.join(homeDir, ".local", "share", "mise", "shims"), "version-manager"],
      [pathApi.join(homeDir, ".asdf", "shims"), "version-manager"],
      [
        platform === "darwin"
          ? pathApi.join(homeDir, "Library", "pnpm")
          : pathApi.join(homeDir, ".local", "share", "pnpm"),
        "version-manager",
      ],
      [
        envValue(env, "BUN_INSTALL", platform)
          ? pathApi.join(envValue(env, "BUN_INSTALL", platform)!, "bin")
          : undefined,
        "bun",
      ],
      [envValue(env, "PNPM_HOME", platform), "version-manager"],
      [envValue(env, "UV_TOOL_BIN_DIR", platform), "uv"],
      [envValue(env, "XDG_BIN_HOME", platform), "uv"],
      [
        envValue(env, "XDG_DATA_HOME", platform)
          ? pathApi.join(envValue(env, "XDG_DATA_HOME", platform)!, "..", "bin")
          : undefined,
        "uv",
      ],
      ["/opt/homebrew/bin", "homebrew"],
      ["/usr/local/bin", "system"],
      ["/home/linuxbrew/.linuxbrew/bin", "homebrew"],
      ["/opt/local/bin", "macports"],
      ["/usr/bin", "system"],
      ["/bin", "system"],
    ];
    posixDirectories.forEach(([directory, source], index) =>
      addDirectorySeed(seeds, seen, directory, source, 1_000 + index, platform),
    );
    await addVersionManagerDirectories(
      seeds,
      seen,
      pathApi.join(homeDir, ".nvm", "versions", "node"),
      ["bin"],
      platform,
    );
    const fnmRoot =
      safeDirectory(envValue(env, "FNM_DIR", platform), platform) ??
      (platform === "darwin"
        ? pathApi.join(homeDir, "Library", "Application Support", "fnm")
        : pathApi.join(homeDir, ".local", "share", "fnm"));
    await addVersionManagerDirectories(
      seeds,
      seen,
      pathApi.join(fnmRoot, "node-versions"),
      ["installation", "bin"],
      platform,
    );
  }
  return seeds;
}

function candidateNames(command: string, platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
}

function launchForm(executable: string, platform: NodeJS.Platform): HerdrAgentCliCandidate["launchForm"] {
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable)) return "windows-cmd";
  return platform === "win32" ? "native" : "posix-script";
}

async function inspectCandidate(
  entry: AgentCliCatalogEntry,
  seed: DirectorySeed,
  platform: NodeJS.Platform,
): Promise<HerdrAgentCliCandidate | undefined> {
  const pathApi = platformPath(platform);
  for (const name of candidateNames(entry.command, platform)) {
    const executable = pathApi.join(seed.directory, name);
    try {
      const info = await stat(executable);
      if (!info.isFile()) continue;
      if (platform !== "win32") await access(executable, fsConstants.X_OK);
      const canonical = await realpath(executable);
      if (!safeDirectory(canonical, platform)) continue;
      return {
        kind: entry.kind,
        executable,
        realExecutable: canonical,
        directory: seed.directory,
        source: seed.source,
        launchForm: launchForm(executable, platform),
        precedence: seed.precedence,
      };
    } catch {
      // Continue through the bounded allowlisted candidates.
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function createOverlay(
  userDataDir: string,
  selected: ReadonlyMap<HerdrStartableAgentKind, HerdrAgentCliCandidate | undefined>,
  platform: NodeJS.Platform,
): Promise<{ directory: string; revision: number }> {
  const entries = [...selected.entries()].filter((entry): entry is [HerdrStartableAgentKind, HerdrAgentCliCandidate] =>
    Boolean(entry[1]),
  );
  const fingerprint = createHash("sha256")
    .update(
      entries.map(([kind, candidate]) => `${kind}\0${candidate.executable}\0${candidate.realExecutable}`).join("\0"),
    )
    .digest("hex")
    .slice(0, 16);
  const revision = Number.parseInt(fingerprint.slice(0, 12), 16);
  const root = path.join(userDataDir, "herdr", "agent-bin");
  const directory = path.join(root, fingerprint);
  try {
    const existing = await stat(directory);
    if (existing.isDirectory()) return { directory, revision };
  } catch {
    // Create it below.
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.${fingerprint}.staging-${process.pid}-${Date.now()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [kind, candidate] of entries) {
      if (platform === "win32") {
        const wrapper = `@echo off\r\ncall "${candidate.executable.replace(/"/gu, '""')}" %*\r\n`;
        await writeFile(path.join(staging, `${kind}.cmd`), wrapper, { encoding: "utf8", mode: 0o600 });
      } else {
        const wrapper = `#!/bin/sh\nexec ${shellQuote(candidate.executable)} "$@"\n`;
        const output = path.join(staging, kind);
        await writeFile(output, wrapper, { encoding: "utf8", mode: 0o700 });
        await chmod(output, 0o700);
      }
    }
    try {
      await rename(staging, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { directory, revision };
}

export async function discoverHerdrAgentClis(
  options: HerdrAgentCliDiscoveryOptions,
): Promise<HerdrAgentCliDiscoverySnapshot> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platformPath(platform);
  const commonSeeds = await collectAgentCliDirectorySeeds({ homeDir: options.homeDir, platform, env });
  const selected = new Map<HerdrStartableAgentKind, HerdrAgentCliCandidate | undefined>();
  const candidates = new Map<HerdrStartableAgentKind, readonly HerdrAgentCliCandidate[]>();
  const diagnostics: HerdrAgentCliDiagnostic[] = [];

  for (const entry of HERDR_AGENT_CLI_CATALOG) {
    const entrySeeds: DirectorySeed[] = [];
    const seen = new Set<string>();
    for (const override of entry.environmentDirectories) {
      const base = safeDirectory(envValue(env, override.key, platform), platform);
      addDirectorySeed(
        entrySeeds,
        seen,
        base ? pathApi.join(base, ...("suffix" in override ? override.suffix : [])) : undefined,
        "custom",
        0,
        platform,
      );
    }
    for (const seed of commonSeeds) {
      addDirectorySeed(entrySeeds, seen, seed.directory, seed.source, seed.precedence, platform);
    }
    const officialRelative =
      platform === "win32" ? entry.windowsHomeRelativeDirectories : entry.posixHomeRelativeDirectories;
    for (const parts of officialRelative) {
      addDirectorySeed(entrySeeds, seen, pathApi.join(options.homeDir, ...parts), "official", 1_000, platform);
    }
    if (platform === "win32") {
      const localAppData =
        safeDirectory(envValue(env, "LOCALAPPDATA", platform), platform) ??
        pathApi.join(options.homeDir, "AppData", "Local");
      for (const parts of entry.windowsLocalAppDataRelativeDirectories) {
        addDirectorySeed(entrySeeds, seen, pathApi.join(localAppData, ...parts), "official", 1_000, platform);
      }
    }
    const inspected = (
      await Promise.all(
        entrySeeds.slice(0, MAX_CANDIDATES_PER_KIND).map((seed) => inspectCandidate(entry, seed, platform)),
      )
    ).filter((candidate): candidate is HerdrAgentCliCandidate => Boolean(candidate));
    const unique = new Map<string, HerdrAgentCliCandidate>();
    for (const candidate of inspected.sort((left, right) => left.precedence - right.precedence)) {
      const key = pathKey(candidate.realExecutable, platform);
      if (!unique.has(key)) unique.set(key, candidate);
    }
    const values = [...unique.values()];
    const winner = values[0];
    selected.set(entry.kind, winner);
    candidates.set(entry.kind, values);
    diagnostics.push({
      kind: entry.kind,
      available: Boolean(winner),
      status: winner ? (values.length > 1 ? "ambiguous" : "detected") : "missing-locally",
      ...(winner ? { source: winner.source } : { errorCode: "HERDR_AGENT_BINARY_MISSING" as const }),
      candidateCount: values.length,
    });
  }

  const overlay = await createOverlay(options.userDataDir, selected, platform);
  const supportDirectories = [...selected.values()]
    .filter((candidate): candidate is HerdrAgentCliCandidate => Boolean(candidate))
    .map((candidate) => candidate.directory);
  const pathEntries = [
    overlay.directory,
    ...(envValue(env, "PATH", platform) ?? "").split(pathDelimiter(platform)),
    ...supportDirectories,
  ]
    .map((entry) => safeDirectory(entry, platform))
    .filter((entry): entry is string => Boolean(entry));
  const seenPath = new Set<string>();
  const managedPath = pathEntries
    .filter((entry) => {
      const key = pathKey(entry, platform);
      if (seenPath.has(key)) return false;
      seenPath.add(key);
      return true;
    })
    .join(pathDelimiter(platform));

  return {
    revision: overlay.revision,
    generatedAt: Date.now(),
    selected,
    candidates,
    diagnostics,
    overlayDirectory: overlay.directory,
    managedPath,
  };
}
