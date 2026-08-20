import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FileIndexEntry } from "../shared/file-fuzzy";
import { filterFileEntries } from "../shared/file-fuzzy";
import { ToolchainError } from "../shared/toolchains/errors";
import { canonicalPath, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access-core";
import { toolchainRuntime } from "./toolchain-runtime";

export const FILE_SUGGESTION_DIRECT_LIMIT = 300;
export const FILE_SUGGESTION_SEARCH_LIMIT = 300;
export const FILE_SUGGESTION_RETURN_LIMIT = 50;
export const FILE_SUGGESTION_SEARCH_TIMEOUT_MS = 2_000;
export const FILE_SUGGESTION_SEARCH_MAX_BUFFER = 2 * 1024 * 1024;

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);
const WINDOWS_IGNORED_NAMES = new Set([...IGNORED_NAMES].map((name) => name.toLocaleLowerCase("en-US")));

export type FileSuggestionDegradedReason = "search-unavailable" | "search-timeout" | "search-failed";

export interface FileSuggestionMatch {
  path: string;
  isDir?: boolean;
  score?: number;
}

export interface FileSuggestionResult {
  files: string[];
  truncated: boolean;
  truncatedReason?: "count";
  matches: FileSuggestionMatch[];
  degradedReason?: FileSuggestionDegradedReason;
}

export interface FileSuggestionSearchRequest {
  cwd: string;
  pattern: string;
  searchPaths: string[];
  fullPath: boolean;
}

export type FileSuggestionSearchRunner = (request: FileSuggestionSearchRequest) => Promise<string[]>;

export interface FileSuggestionService {
  suggest(root: string, query?: string): Promise<FileSuggestionResult>;
}

export interface FileSuggestionServiceOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  runSearch?: FileSuggestionSearchRunner;
}

export class FileSuggestionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSuggestionRequestError";
  }
}

interface ResolvedScope {
  scope: string;
  query: string;
  needle: string;
  browse: boolean;
  fullPath: boolean;
  explicitHidden: boolean;
  explicitHomeSystemDirectory: boolean;
}

interface ListedEntries {
  entries: FileIndexEntry[];
  truncated: boolean;
}

function pathModule(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path;
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

export function fileSuggestionPathKey(value: string, platform: NodeJS.Platform): string {
  return comparablePath(value.replace(/\\/g, "/"), platform);
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return (
    comparablePath(canonicalPath(left, platform === "win32"), platform) ===
    comparablePath(canonicalPath(right, platform === "win32"), platform)
  );
}

function toPosixRelative(root: string, candidate: string, platform: NodeJS.Platform): string | null {
  const resolver = pathModule(platform);
  const relative = resolver.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${resolver.sep}`) || resolver.isAbsolute(relative)) {
    return null;
  }
  return relative.split(resolver.sep).join("/");
}

export function normalizeFileSuggestionQuery(query: string | undefined): string {
  const normalized = (query ?? "").replace(/\\/g, "/");
  if (normalized.includes("\0")) throw new FileSuggestionRequestError("Invalid file suggestion query");
  if (normalized.startsWith("/") || isWindowsAbsolutePath(normalized)) {
    throw new FileSuggestionRequestError("Absolute file suggestion queries are not allowed");
  }
  const withoutCurrentDirectory = normalized.replace(/^(?:\.\/)+/, "");
  if (withoutCurrentDirectory.split("/").some((segment) => segment === "..")) {
    throw new FileSuggestionRequestError("Parent traversal is not allowed in file suggestion queries");
  }
  return withoutCurrentDirectory;
}

export function isHomeSystemDirectoryName(name: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return name.toLocaleLowerCase("en-US") === "appdata";
  return platform === "darwin" && name === "Library";
}

export function buildFdFuzzyPattern(query: string): string {
  return Array.from(query)
    .map((character) => {
      if (character === "/") return "[/\\\\]";
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join(".*");
}

export function classifyFileSuggestionSearchError(error: unknown): FileSuggestionDegradedReason {
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown; cause?: unknown } | null;
  if (
    (error instanceof ToolchainError || (candidate && typeof candidate === "object")) &&
    candidate?.code === "TOOLCHAIN_CAPABILITY_REQUIRED"
  ) {
    return "search-unavailable";
  }
  if (
    candidate?.code === "ETIMEDOUT" ||
    candidate?.killed === true ||
    candidate?.signal === "SIGTERM" ||
    (error instanceof Error && /timed?\s*out/i.test(error.message))
  ) {
    return "search-timeout";
  }
  if (candidate?.cause && candidate.cause !== error) return classifyFileSuggestionSearchError(candidate.cause);
  return "search-failed";
}

export function buildFdSearchArgs(request: FileSuggestionSearchRequest): string[] {
  return [
    "--color=never",
    "--hidden",
    "--absolute-path",
    "--print0",
    "--ignore-case",
    "--type",
    "f",
    "--type",
    "d",
    ...[...IGNORED_NAMES].flatMap((name) => ["--exclude", name]),
    "--max-results",
    String(FILE_SUGGESTION_SEARCH_LIMIT),
    ...(request.fullPath ? ["--full-path"] : []),
    "--",
    request.pattern,
    ...request.searchPaths,
  ];
}

async function defaultSearchRunner(request: FileSuggestionSearchRequest): Promise<string[]> {
  if (request.searchPaths.length === 0) return [];
  const args = buildFdSearchArgs(request);
  const result = await toolchainRuntime.exec("search.fd", args, {
    cwd: request.cwd,
    intent: "project-command",
    timeout: FILE_SUGGESTION_SEARCH_TIMEOUT_MS,
    maxBuffer: FILE_SUGGESTION_SEARCH_MAX_BUFFER,
  });
  return result.stdout.split("\0").filter(Boolean);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function entryDirectoryState(candidate: string): Promise<boolean | null> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return null;
  }
}

async function resolveScope(
  root: string,
  rawQuery: string | undefined,
  platform: NodeJS.Platform,
  homeDirectory: string,
): Promise<ResolvedScope> {
  const resolver = pathModule(platform);
  const query = normalizeFileSuggestionQuery(rawQuery);
  const segments = query.split("/").filter(Boolean);
  const explicitHidden = segments.some((segment) => segment.startsWith("."));
  const homeSystemName = platform === "win32" ? "appdata" : platform === "darwin" ? "Library" : "";
  const firstSegment = segments[0] ?? "";
  const explicitHomeSystemDirectory =
    samePath(root, homeDirectory, platform) &&
    Boolean(homeSystemName) &&
    (platform === "win32"
      ? firstSegment.toLocaleLowerCase("en-US") === homeSystemName
      : firstSegment === homeSystemName);

  if (!query) {
    return {
      scope: root,
      query,
      needle: "",
      browse: true,
      fullPath: false,
      explicitHidden,
      explicitHomeSystemDirectory,
    };
  }

  const trailingSlash = query.endsWith("/");
  const lastSlash = query.lastIndexOf("/");
  const scopePart = trailingSlash ? query.slice(0, -1) : lastSlash >= 0 ? query.slice(0, lastSlash) : "";
  if (scopePart) {
    const candidateScope = resolver.resolve(root, ...scopePart.split("/"));
    if (!isFilePathAllowed(candidateScope, new Set([root]))) {
      throw new FileSuggestionRequestError("File suggestion scope is outside the allowed root");
    }
    if (await isDirectory(candidateScope)) {
      return {
        scope: candidateScope,
        query,
        needle: trailingSlash ? "" : query.slice(lastSlash + 1),
        browse: trailingSlash,
        fullPath: false,
        explicitHidden,
        explicitHomeSystemDirectory,
      };
    }
  }

  return {
    scope: root,
    query,
    needle: query,
    browse: false,
    fullPath: query.includes("/"),
    explicitHidden,
    explicitHomeSystemDirectory,
  };
}

function shouldHideName(
  name: string,
  platform: NodeJS.Platform,
  resolved: ResolvedScope,
  homeRootScope: boolean,
): boolean {
  if (isIgnoredName(name, platform)) return true;
  if (name.startsWith(".") && !resolved.explicitHidden) return true;
  if (!homeRootScope) return false;
  if (resolved.explicitHomeSystemDirectory) return false;
  return isHomeSystemDirectoryName(name, platform);
}

function isIgnoredName(name: string, platform: NodeJS.Platform): boolean {
  if (IGNORED_NAMES.has(name)) return true;
  if (platform !== "win32") return false;
  return WINDOWS_IGNORED_NAMES.has(name.toLocaleLowerCase("en-US"));
}

async function listDirectEntries(
  root: string,
  resolved: ResolvedScope,
  platform: NodeJS.Platform,
  homeDirectory: string,
  limit: number = FILE_SUGGESTION_DIRECT_LIMIT,
): Promise<ListedEntries> {
  let directoryEntries;
  try {
    directoryEntries = await readdir(resolved.scope, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }
  directoryEntries.sort(
    (left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
  );

  const entries: FileIndexEntry[] = [];
  const homeRootScope = samePath(resolved.scope, root, platform) && samePath(root, homeDirectory, platform);
  for (const entry of directoryEntries) {
    if (shouldHideName(entry.name, platform, resolved, homeRootScope)) continue;
    const absolutePath = pathModule(platform).join(resolved.scope, entry.name);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      if (!isFilePathAllowed(absolutePath, new Set([root]))) continue;
      const symlinkDirectory = await entryDirectoryState(absolutePath);
      if (symlinkDirectory === null) continue;
      directory = symlinkDirectory;
    }
    const relativePath = toPosixRelative(root, absolutePath, platform);
    if (!relativePath) continue;
    if (entries.length >= limit) return { entries, truncated: true };
    entries.push({ path: relativePath, isDir: directory });
  }
  return { entries, truncated: false };
}

async function listDirectSearchEntries(
  root: string,
  resolved: ResolvedScope,
  platform: NodeJS.Platform,
  homeDirectory: string,
): Promise<ListedEntries> {
  let directoryEntries;
  try {
    directoryEntries = await readdir(resolved.scope, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }

  const resolver = pathModule(platform);
  const candidates: FileIndexEntry[] = [];
  const homeRootScope = samePath(resolved.scope, root, platform) && samePath(root, homeDirectory, platform);
  for (const entry of directoryEntries) {
    if (shouldHideName(entry.name, platform, resolved, homeRootScope)) continue;
    const relativePath = toPosixRelative(root, resolver.join(resolved.scope, entry.name), platform);
    if (!relativePath) continue;
    candidates.push({ path: relativePath, isDir: entry.isDirectory() });
  }
  const ranked = filterFileEntries(candidates, resolved.query, FILE_SUGGESTION_DIRECT_LIMIT + 1);
  const entries: FileIndexEntry[] = [];
  for (const candidate of ranked.slice(0, FILE_SUGGESTION_DIRECT_LIMIT)) {
    const absolutePath = resolver.join(root, ...candidate.path.split("/"));
    if (!isFilePathAllowed(absolutePath, new Set([root]))) continue;
    const directory = await entryDirectoryState(absolutePath);
    if (directory === null) continue;
    entries.push({ path: candidate.path, isDir: directory });
  }
  return { entries, truncated: ranked.length > FILE_SUGGESTION_DIRECT_LIMIT };
}

async function entriesFromSearchResults(
  root: string,
  absolutePaths: string[],
  platform: NodeJS.Platform,
  resolved: ResolvedScope,
): Promise<FileIndexEntry[]> {
  const entries: FileIndexEntry[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < absolutePaths.length; offset += 16) {
    const batch = absolutePaths.slice(offset, offset + 16);
    const mapped = await Promise.all(
      batch.map(async (absolutePath) => {
        if (!isFilePathAllowed(absolutePath, new Set([root]))) return null;
        const canonicalCandidate = canonicalPath(absolutePath, platform === "win32");
        const relativePath = toPosixRelative(root, canonicalCandidate, platform);
        const relativeKey = relativePath ? fileSuggestionPathKey(relativePath, platform) : "";
        if (!relativePath || seen.has(relativeKey)) return null;
        if (relativePath.split("/").some((segment) => isIgnoredName(segment, platform))) return null;
        if (!resolved.explicitHidden && relativePath.split("/").some((segment) => segment.startsWith("."))) {
          return null;
        }
        const directory = await entryDirectoryState(canonicalCandidate);
        if (directory === null) return null;
        return { path: relativePath, isDir: directory } satisfies FileIndexEntry;
      }),
    );
    for (const entry of mapped) {
      const entryKey = entry ? fileSuggestionPathKey(entry.path, platform) : "";
      if (!entry || seen.has(entryKey)) continue;
      seen.add(entryKey);
      entries.push(entry);
    }
  }
  return entries;
}

function projectResult(
  entries: FileIndexEntry[],
  query: string,
  truncated: boolean,
  degradedReason?: FileSuggestionDegradedReason,
): FileSuggestionResult {
  const ranked = filterFileEntries(entries, query, entries.length);
  const matches = ranked.slice(0, FILE_SUGGESTION_RETURN_LIMIT);
  const resultTruncated = truncated || ranked.length > matches.length;
  return {
    files: matches.filter((entry) => !entry.isDir).map((entry) => entry.path),
    truncated: resultTruncated,
    ...(resultTruncated ? { truncatedReason: "count" as const } : {}),
    matches: matches.map((entry) => ({ path: entry.path, isDir: entry.isDir, score: 0 })),
    ...(degradedReason ? { degradedReason } : {}),
  };
}

function logFileSuggestionDiagnostic(
  mode: "browse" | "search",
  resolved: ResolvedScope,
  root: string,
  result: FileSuggestionResult,
  startedAt: number,
): void {
  if (process.env.PI_FILE_SUGGESTION_DIAGNOSTICS !== "1") return;
  console.info(
    "[file-suggestions]",
    JSON.stringify({
      mode,
      scope: resolved.scope === root ? "root" : "nested",
      queryLength: Array.from(resolved.query).length,
      resultCount: result.matches.length,
      truncated: result.truncated,
      degraded: result.degradedReason ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
    }),
  );
}

export function createFileSuggestionService(options: FileSuggestionServiceOptions = {}): FileSuggestionService {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const runSearch = options.runSearch ?? defaultSearchRunner;

  return {
    async suggest(rootInput: string, rawQuery?: string): Promise<FileSuggestionResult> {
      const startedAt = Date.now();
      const resolver = pathModule(platform);
      const root = canonicalPath(resolver.resolve(rootInput), platform === "win32");
      if (!(await isDirectory(root))) throw new FileSuggestionRequestError("File suggestion root is not a directory");
      const resolved = await resolveScope(root, rawQuery, platform, homeDirectory);
      const direct = await listDirectEntries(root, resolved, platform, homeDirectory);

      if (resolved.browse) {
        const result = projectResult(direct.entries, "", direct.truncated);
        logFileSuggestionDiagnostic("browse", resolved, root, result, startedAt);
        return result;
      }

      const directSearch = direct.truncated
        ? await listDirectSearchEntries(root, resolved, platform, homeDirectory)
        : direct;
      const fallback = () => projectResult(directSearch.entries, resolved.query, directSearch.truncated);
      let searchPaths = [resolved.scope];
      let searchRootsTruncated = false;
      if (
        samePath(resolved.scope, root, platform) &&
        samePath(root, homeDirectory, platform) &&
        !resolved.explicitHomeSystemDirectory
      ) {
        const rootDirectories = direct.entries
          .filter((entry) => entry.isDir)
          .map((entry) => resolver.join(root, ...entry.path.split("/")));
        searchPaths = rootDirectories;
        searchRootsTruncated = direct.truncated;
      }

      try {
        const absolutePaths = await runSearch({
          cwd: resolved.scope,
          pattern: buildFdFuzzyPattern(resolved.needle),
          searchPaths,
          fullPath: resolved.fullPath,
        });
        const searched = await entriesFromSearchResults(
          root,
          absolutePaths.slice(0, FILE_SUGGESTION_SEARCH_LIMIT),
          platform,
          resolved,
        );
        const byPath = new Map<string, FileIndexEntry>();
        for (const entry of [...directSearch.entries, ...searched]) {
          byPath.set(fileSuggestionPathKey(entry.path, platform), entry);
        }
        const result = projectResult(
          [...byPath.values()],
          resolved.query,
          directSearch.truncated || searchRootsTruncated || absolutePaths.length >= FILE_SUGGESTION_SEARCH_LIMIT,
        );
        logFileSuggestionDiagnostic("search", resolved, root, result, startedAt);
        return result;
      } catch (error) {
        const result: FileSuggestionResult = {
          ...fallback(),
          truncated: true,
          truncatedReason: "count",
          degradedReason: classifyFileSuggestionSearchError(error),
        };
        logFileSuggestionDiagnostic("search", resolved, root, result, startedAt);
        return result;
      }
    },
  };
}

export const fileSuggestionService = createFileSuggestionService();
