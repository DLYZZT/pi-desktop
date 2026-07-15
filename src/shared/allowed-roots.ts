// Process-local roots that should be browsable in addition to roots derived
// from persisted sessions. The Agent Host owns this state for its lifetime.
export type AllowedRootsCache = { roots: Set<string>; expiresAt: number };

const additionalAllowedRoots = new Set<string>();
let allowedRootsCache: AllowedRootsCache | undefined;
let allowedRootsGeneration = 0;

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function getAdditionalAllowedRoots(): Set<string> {
  return additionalAllowedRoots;
}

export function getAllowedRootsCache(): AllowedRootsCache | undefined {
  return allowedRootsCache;
}

export function setAllowedRootsCache(cache: AllowedRootsCache | undefined): void {
  allowedRootsCache = cache;
}

/** Snapshot the invalidation generation before starting an async roots scan. */
export function getAllowedRootsGeneration(): number {
  return allowedRootsGeneration;
}

/**
 * Publish a scan result only if no invalidation happened while it was running.
 * This prevents an older async scan from restoring stale roots with a long TTL.
 */
export function setAllowedRootsCacheIfCurrent(cache: AllowedRootsCache, generation: number): boolean {
  if (generation !== allowedRootsGeneration) return false;
  allowedRootsCache = cache;
  return true;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  allowedRootsCache?.roots.add(normalizedRoot);
}

/** Drop TTL cache so next getAllowedFileRoots() re-scans sessions (watcher-driven). */
export function invalidateAllowedRootsCache(): void {
  allowedRootsCache = undefined;
  allowedRootsGeneration++;
}

// TTL policy: with a healthy session watcher every mutation path invalidates
// the cache explicitly, so the TTL is only a safety net. Without a watcher
// (fs.watch failed or degraded), keep the short TTL so session cwds created by
// an external Pi CLI still appear promptly.
const WATCHED_TTL_MS = 10 * 60_000;
const FALLBACK_TTL_MS = 5_000;
let watcherHealthy = false;

export function setAllowedRootsWatcherHealthy(healthy: boolean): void {
  watcherHealthy = healthy;
}

export function allowedRootsCacheTtlMs(): number {
  return watcherHealthy ? WATCHED_TTL_MS : FALLBACK_TTL_MS;
}
