// Process-local roots that should be browsable in addition to roots derived
// from persisted sessions. The Agent Host owns this state for its lifetime.
export type AllowedRootsCache = { roots: Set<string>; expiresAt: number };

const additionalAllowedRoots = new Set<string>();
let allowedRootsCache: AllowedRootsCache | undefined;

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

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  allowedRootsCache?.roots.add(normalizedRoot);
}

/** Drop TTL cache so next getAllowedFileRoots() re-scans sessions (watcher-driven). */
export function invalidateAllowedRootsCache(): void {
  allowedRootsCache = undefined;
}
