import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import type { ProjectToolRequirements } from "../../shared/toolchains/types";
import { isToolPathInside, normalizeToolPath } from "./candidate-normalizer.ts";

const MAX_ANCESTORS = 32;
const MAX_DATA_FILE_BYTES = 256 * 1024;
const MAX_SMALL_FILE_BYTES = 4 * 1024;
const MAX_DIRECTORY_ENTRIES = 512;

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
] as const;

export interface DetectedProjectTools {
  root: string;
  requirements: ProjectToolRequirements;
  pythonExecutable?: string;
  fingerprint: string;
}

export interface DetectProjectToolsOptions {
  trusted: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function exists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function isPlainDirectory(value: string): boolean {
  try {
    const info = fs.lstatSync(value);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainFile(value: string): boolean {
  try {
    const info = fs.lstatSync(value);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isExecutableFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function safeReadFile(filePath: string, maximumBytes = MAX_DATA_FILE_BYTES): string | undefined {
  try {
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) return undefined;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function startingDirectory(cwd: string, platform: NodeJS.Platform): string {
  const normalized = normalizeToolPath(cwd, platform);
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : pathApi(platform).dirname(normalized);
  } catch {
    return normalized;
  }
}

function scanDirectories(cwd: string, platform: NodeJS.Platform): { directories: string[]; root: string } {
  const api = pathApi(platform);
  const all: string[] = [];
  let current = startingDirectory(cwd, platform);
  for (let index = 0; index < MAX_ANCESTORS; index += 1) {
    all.push(current);
    const parent = api.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const gitIndex = all.findIndex((directory) => exists(api.join(directory, ".git")));
  if (gitIndex >= 0) return { directories: all.slice(0, gitIndex + 1), root: all[gitIndex]! };
  const markerIndex = all.findIndex((directory) =>
    PROJECT_MARKERS.some((marker) => exists(api.join(directory, marker))),
  );
  if (markerIndex >= 0) return { directories: all.slice(0, markerIndex + 1), root: all[markerIndex]! };
  return { directories: [all[0]!], root: all[0]! };
}

function nearestFile(directories: readonly string[], name: string, platform: NodeJS.Platform): string | undefined {
  const api = pathApi(platform);
  for (const directory of directories) {
    const candidate = api.join(directory, name);
    if (safeReadFile(candidate) !== undefined) return candidate;
  }
  return undefined;
}

function readSmallNearest(directories: readonly string[], name: string, platform: NodeJS.Platform): string | undefined {
  const api = pathApi(platform);
  for (const directory of directories) {
    const value = safeReadFile(api.join(directory, name), MAX_SMALL_FILE_BYTES);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function normalizeNodeRequest(value: string): string | undefined {
  const request = value.trim().replace(/^v(?=\d)/i, "");
  if (!request || request.length > 256 || /[\0\r\n]/.test(request)) return undefined;
  if (/^(?:node|stable|current|lts(?:\/\*)?)$/i.test(request)) return undefined;
  const numeric = request.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (numeric) {
    const major = Number(numeric[1]);
    if (numeric[3] !== undefined) return `${major}.${Number(numeric[2])}.${Number(numeric[3])}`;
    if (numeric[2] !== undefined) {
      const minor = Number(numeric[2]);
      return `>=${major}.${minor}.0 <${major}.${minor + 1}.0`;
    }
    return `>=${major}.0.0 <${major + 1}.0.0`;
  }
  return semver.validRange(request, { loose: true }) ? request : undefined;
}

export function nodeVersionSatisfies(version: string | undefined, request: string | undefined): boolean {
  if (!request) return true;
  const normalized = semver.valid(version ?? "", { loose: true });
  if (!normalized) return false;
  return request
    .split(" && ")
    .every((range) => Boolean(semver.validRange(range, { loose: true })) && semver.satisfies(normalized, range));
}

function parsePackageJson(text: string | undefined): {
  nodeRange?: string;
  packageManager?: ProjectToolRequirements["packageManager"];
} {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const engines = value.engines;
    const nodeValue =
      engines && typeof engines === "object" && !Array.isArray(engines)
        ? (engines as Record<string, unknown>).node
        : undefined;
    const nodeRange = typeof nodeValue === "string" ? normalizeNodeRequest(nodeValue) : undefined;
    const packageManagerText = typeof value.packageManager === "string" ? value.packageManager : "";
    const match = packageManagerText.match(/^(npm|pnpm|yarn|bun)@[^\s]{1,128}$/i);
    return {
      nodeRange,
      packageManager: match?.[1]?.toLowerCase() as ProjectToolRequirements["packageManager"] | undefined,
    };
  } catch {
    return {};
  }
}

function pyprojectRequiresPython(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let inProject = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (section) {
      inProject = section[1]!.trim() === "project";
      continue;
    }
    if (!inProject) continue;
    const match = line.match(/^\s*requires-python\s*=\s*(["'])([^"']{1,256})\1\s*(?:#.*)?$/);
    if (match?.[2] && isValidPythonRequest(match[2])) return match[2].trim();
  }
  return undefined;
}

function parsePythonVersion(value: string): number[] | undefined {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : undefined;
}

function comparePythonVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function pythonSpecifierMatches(version: readonly number[], specifier: string): boolean {
  const match = specifier.trim().match(/^(~=|==|!=|<=|>=|<|>)?\s*(\d+(?:\.\d+){0,2})(\.\*)?$/);
  if (!match) return false;
  const operator = match[1] ?? "==";
  const requestedText = match[2]!;
  const requested = parsePythonVersion(requestedText);
  if (!requested) return false;
  const comparison = comparePythonVersions(version, requested);
  const requestedParts = requestedText.split(".").length;
  if (match[3]) {
    const prefix = requestedText.split(".").map(Number);
    const equalPrefix = prefix.every((part, index) => version[index] === part);
    return operator === "!=" ? !equalPrefix : operator === "==" && equalPrefix;
  }
  switch (operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "!=":
      return comparison !== 0;
    case "~=": {
      if (comparison < 0) return false;
      const upper = [...requested];
      const upperIndex = requestedParts >= 3 ? 1 : 0;
      upper[upperIndex] = (upper[upperIndex] ?? 0) + 1;
      for (let index = upperIndex + 1; index < upper.length; index += 1) upper[index] = 0;
      return comparePythonVersions(version, upper) < 0;
    }
    case "==":
      return requestedParts === 1
        ? version[0] === requested[0]
        : requestedParts === 2
          ? version[0] === requested[0] && version[1] === requested[1]
          : comparison === 0;
    default:
      return false;
  }
}

function isValidPythonRequest(value: string): boolean {
  const request = value.split(";", 1)[0]!.trim();
  if (!request || request.length > 256) return false;
  return request
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => /^(?:~=|==|!=|<=|>=|<|>)?\s*\d+(?:\.\d+){0,2}(?:\.\*)?$/.test(part));
}

export function normalizePythonVersionRequest(value: string): string | undefined {
  const first = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!first || first.length > 128) return undefined;
  const normalized = first.replace(/^(?:cpython|python)[-@]/i, "").replace(/^v(?=\d)/i, "");
  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return undefined;
  const major = Number(match[1]);
  if (match[3] !== undefined) return `==${major}.${Number(match[2])}.${Number(match[3])}`;
  if (match[2] !== undefined) return `==${major}.${Number(match[2])}.*`;
  return `==${major}.*`;
}

export function pythonVersionSatisfies(version: string | undefined, request: string | undefined): boolean {
  if (!request) return true;
  const parsed = parsePythonVersion(version ?? "");
  if (!parsed) return false;
  return request.split(" && ").every((group) => {
    const normalized = group.split(";", 1)[0]!.trim();
    return (
      normalized.length > 0 &&
      normalized
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .every((specifier) => pythonSpecifierMatches(parsed, specifier))
    );
  });
}

function inferPackageManager(
  directories: readonly string[],
  platform: NodeJS.Platform,
): ProjectToolRequirements["packageManager"] | undefined {
  const api = pathApi(platform);
  const clues: ReadonlyArray<readonly [ProjectToolRequirements["packageManager"], readonly string[]]> = [
    ["pnpm", ["pnpm-lock.yaml"]],
    ["yarn", ["yarn.lock"]],
    ["bun", ["bun.lock", "bun.lockb"]],
    ["npm", ["package-lock.json"]],
  ];
  for (const directory of directories) {
    for (const [manager, names] of clues) {
      if (names.some((name) => isPlainFile(api.join(directory, name)))) {
        return manager;
      }
    }
  }
  return undefined;
}

function findPythonEnvironment(
  directories: readonly string[],
  root: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { directory: string; executable: string } | undefined {
  const api = pathApi(platform);
  const environments: string[] = [];
  for (const directory of directories) environments.push(api.join(directory, ".venv"));
  const environmentKey =
    platform === "win32" ? Object.keys(env).find((key) => key.toLowerCase() === "virtual_env") : "VIRTUAL_ENV";
  const environmentValue = environmentKey ? env[environmentKey] : undefined;
  if (environmentValue && api.isAbsolute(environmentValue) && isToolPathInside(environmentValue, root, platform)) {
    environments.push(normalizeToolPath(environmentValue, platform));
  }
  const executableNames =
    platform === "win32"
      ? [api.join("Scripts", "python.exe"), api.join("Scripts", "python3.exe")]
      : [api.join("bin", "python3"), api.join("bin", "python")];
  for (const directory of environments) {
    if (!isToolPathInside(directory, root, platform) || !isPlainDirectory(directory)) continue;
    for (const name of executableNames) {
      const executable = api.join(directory, name);
      if (isToolPathInside(executable, directory, platform) && isExecutableFile(executable)) {
        return { directory, executable };
      }
    }
  }
  return undefined;
}

function requirementsMarkers(
  directories: readonly string[],
  platform: NodeJS.Platform,
): { markers: string[]; hasRequirements: boolean } {
  const api = pathApi(platform);
  const markers = new Set<string>();
  for (const directory of directories) {
    for (const marker of PROJECT_MARKERS) {
      const markerPath = api.join(directory, marker);
      if (marker === ".git" ? exists(markerPath) : isPlainFile(markerPath)) markers.add(marker);
    }
  }
  let hasRequirements = false;
  for (const directory of directories) {
    try {
      const names = fs.readdirSync(directory).slice(0, MAX_DIRECTORY_ENTRIES);
      if (names.some((name) => /^requirements(?:[-_.][^/]*)?\.txt$/i.test(name))) {
        hasRequirements = true;
        break;
      }
    } catch {
      // A project declaration scan is best-effort and read-only.
    }
  }
  if (hasRequirements) markers.add("requirements.txt");
  return { markers: [...markers].sort(), hasRequirements };
}

export function detectProjectTools(cwd: string, options: DetectProjectToolsOptions): DetectedProjectTools {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const { directories, root } = scanDirectories(cwd, platform);
  const packagePath = nearestFile(directories, "package.json", platform);
  const packageData = parsePackageJson(packagePath ? safeReadFile(packagePath) : undefined);
  const versionFile =
    readSmallNearest(directories, ".nvmrc", platform) ?? readSmallNearest(directories, ".node-version", platform);
  const versionRange = versionFile ? normalizeNodeRequest(versionFile.trim()) : undefined;
  const nodeRange = [versionRange, packageData.nodeRange].filter(Boolean).join(" && ") || undefined;

  const pyprojectPath = nearestFile(directories, "pyproject.toml", platform);
  const requiresPython = pyprojectRequiresPython(pyprojectPath ? safeReadFile(pyprojectPath) : undefined);
  const pythonVersionText = readSmallNearest(directories, ".python-version", platform);
  const pythonVersionRequest = pythonVersionText ? normalizePythonVersionRequest(pythonVersionText) : undefined;
  const pythonRequest = [pythonVersionRequest, requiresPython].filter(Boolean).join(" && ") || undefined;
  const pythonEnvironment = findPythonEnvironment(directories, root, platform, env);
  const { markers } = requirementsMarkers(directories, platform);
  if (packageData.nodeRange) markers.push("package.json#engines.node");
  if (packageData.packageManager) markers.push("package.json#packageManager");
  if (requiresPython) markers.push("pyproject.toml#requires-python");
  if (pythonEnvironment) markers.push(options.trusted ? "python-environment" : "python-environment-blocked");

  const requirements: ProjectToolRequirements = {
    cwd: normalizeToolPath(cwd, platform),
    trusted: options.trusted,
    nodeRange,
    packageManager: packageData.packageManager ?? inferPackageManager(directories, platform),
    pythonRequest,
    pythonEnvironment: pythonEnvironment?.directory,
    markers: [...new Set(markers)].sort(),
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        root: normalizeToolPath(root, platform),
        trusted: requirements.trusted,
        nodeRange: requirements.nodeRange,
        packageManager: requirements.packageManager,
        pythonRequest: requirements.pythonRequest,
        pythonEnvironment: requirements.pythonEnvironment,
        markers: requirements.markers,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    root: normalizeToolPath(root, platform),
    requirements,
    pythonExecutable: options.trusted ? pythonEnvironment?.executable : undefined,
    fingerprint,
  };
}
