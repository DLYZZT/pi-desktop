import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "./file-fuzzy";

export type FileSuggestionDegradedReason = "search-unavailable" | "search-timeout" | "search-failed";

export interface FileSuggestionSnapshot {
  matches: FileIndexEntry[];
  truncated: boolean;
  degradedReason?: FileSuggestionDegradedReason;
}

interface FileSuggestionWireResponse {
  files?: unknown;
  matches?: unknown;
  truncated?: unknown;
  degradedReason?: unknown;
}

interface CachedFileSuggestion {
  value: FileSuggestionSnapshot;
  expiresAt: number;
}

const DEGRADED_REASONS = new Set<FileSuggestionDegradedReason>([
  "search-unavailable",
  "search-timeout",
  "search-failed",
]);

function validEntry(value: unknown): FileIndexEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { path?: unknown; isDir?: unknown };
  if (!validRelativeSuggestionPath(candidate.path)) return null;
  return { path: candidate.path, isDir: candidate.isDir === true };
}

function validRelativeSuggestionPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) return false;
  return !value.split("/").some((segment) => segment === "..");
}

export function projectFileSuggestionResponse(data: unknown, query: string): FileSuggestionSnapshot {
  const response = (data && typeof data === "object" ? data : {}) as FileSuggestionWireResponse;
  let matches: FileIndexEntry[];
  if (Array.isArray(response.matches)) {
    matches = response.matches
      .map(validEntry)
      .filter((entry): entry is FileIndexEntry => entry !== null)
      .slice(0, 20);
  } else {
    const files = Array.isArray(response.files) ? response.files.filter(validRelativeSuggestionPath) : [];
    matches = filterFileEntries(buildEntriesFromFiles(files), query);
  }
  const degradedReason = DEGRADED_REASONS.has(response.degradedReason as FileSuggestionDegradedReason)
    ? (response.degradedReason as FileSuggestionDegradedReason)
    : undefined;
  return {
    matches,
    truncated: response.truncated === true,
    ...(degradedReason ? { degradedReason } : {}),
  };
}

export function fileSuggestionCacheKey(cwd: string, query: string, platform: NodeJS.Platform): string {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const comparableCwd = platform === "win32" ? normalizedCwd.toLocaleLowerCase("en-US") : normalizedCwd;
  const comparableQuery = platform === "win32" ? query.toLocaleLowerCase("en-US") : query;
  return `${comparableCwd}\0${comparableQuery}`;
}

export class FileSuggestionLruCache {
  private readonly entries = new Map<string, CachedFileSuggestion>();

  constructor(
    private readonly capacity = 32,
    private readonly ttlMs = 10_000,
  ) {}

  get(key: string, now: number = Date.now()): FileSuggestionSnapshot | null {
    const cached = this.entries.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.value;
  }

  set(key: string, value: FileSuggestionSnapshot, now: number = Date.now()): void {
    this.setWithTtl(key, value, this.ttlMs, now);
  }

  setWithTtl(key: string, value: FileSuggestionSnapshot, ttlMs: number, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
