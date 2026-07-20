import { realpathSync } from "node:fs";
import path from "node:path";
import type { ToolCandidate, ToolHealth, ToolProvider } from "../../shared/toolchains/types";

export interface PathRedactionRoot {
  path: string;
  label: string;
}

export interface CandidateNormalizationOptions {
  platform?: NodeJS.Platform;
  resolveRealPath?: (value: string) => string;
}

const PROVIDER_ORDER: Record<ToolProvider, number> = {
  project: 0,
  custom: 1,
  system: 2,
  bundled: 3,
  managed: 4,
  "legacy-upstream-managed": 5,
};

const HEALTH_ORDER: Record<ToolHealth, number> = {
  healthy: 0,
  unverified: 1,
  incomplete: 2,
  unsupported: 3,
  modified: 4,
  broken: 5,
  "blocked-by-trust": 6,
  missing: 7,
};

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export function normalizeToolPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.length === 0) return "";
  const api = pathApi(platform);
  let normalized = api.normalize(stripWrappingQuotes(value));
  if (platform === "win32") {
    normalized = normalized.replace(/\//g, "\\");
    if (/^[a-z]:\\/i.test(normalized)) {
      normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
    }
    if (normalized.length > 3 && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  } else if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function toolPathComparisonKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalizeToolPath(value, platform);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function isToolPathInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const candidateKey = toolPathComparisonKey(candidate, platform);
  const rootKey = toolPathComparisonKey(root, platform);
  if (candidateKey === rootKey) return true;
  const relative = api.relative(rootKey, candidateKey);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function safeRealPath(value: string, resolveRealPath?: (input: string) => string): string {
  try {
    return (resolveRealPath ?? realpathSync.native)(value);
  } catch {
    return value;
  }
}

export function candidateIdentity(candidate: ToolCandidate, options: CandidateNormalizationOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const resolved = safeRealPath(candidate.executable, options.resolveRealPath);
  const executableKey = toolPathComparisonKey(resolved, platform);
  const prefixKey = (candidate.argvPrefix ?? []).map((entry) => toolPathComparisonKey(entry, platform)).join("\0");
  return [candidate.capability, executableKey, prefixKey].join("\0");
}

export function compareToolCandidates(a: ToolCandidate, b: ToolCandidate): number {
  const health = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
  if (health !== 0) return health;
  const provider = PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider];
  if (provider !== 0) return provider;
  const pathOrderA = a.pathOrder ?? Number.MAX_SAFE_INTEGER;
  const pathOrderB = b.pathOrder ?? Number.MAX_SAFE_INTEGER;
  if (pathOrderA !== pathOrderB) return pathOrderA - pathOrderB;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.id.localeCompare(b.id, "en");
}

export function stableSortToolCandidates(candidates: readonly ToolCandidate[]): ToolCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => compareToolCandidates(left.candidate, right.candidate) || left.index - right.index)
    .map(({ candidate }) => candidate);
}

export function normalizeAndDedupeCandidates(
  candidates: readonly ToolCandidate[],
  options: CandidateNormalizationOptions = {},
): ToolCandidate[] {
  const sorted = stableSortToolCandidates(candidates);
  const seen = new Set<string>();
  const result: ToolCandidate[] = [];
  for (const candidate of sorted) {
    const id = candidateIdentity(candidate, options);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(candidate);
  }
  return result;
}

export function redactToolPath(
  value: string,
  roots: readonly PathRedactionRoot[],
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeToolPath(value, platform);
  const orderedRoots = [...roots]
    .filter((root) => root.path.length > 0 && root.label.length > 0)
    .sort(
      (left, right) => normalizeToolPath(right.path, platform).length - normalizeToolPath(left.path, platform).length,
    );
  for (const root of orderedRoots) {
    if (!isToolPathInside(normalized, root.path, platform)) continue;
    const api = pathApi(platform);
    const relative = api.relative(normalizeToolPath(root.path, platform), normalized);
    if (!relative) return root.label;
    return root.label + "/" + relative.replace(/\\/g, "/");
  }
  return normalized;
}

export function normalizePathEntries(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!value) return [];
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(delimiter)) {
    if (!entry) continue;
    const normalized = normalizeToolPath(entry, platform);
    if (!normalized || !pathApi(platform).isAbsolute(normalized)) continue;
    const key = toolPathComparisonKey(normalized, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
