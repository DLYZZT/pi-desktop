import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  allowedRootsCacheTtlMs,
  getAdditionalAllowedRoots,
  getAllowedRootsCache,
  getAllowedRootsGeneration,
  normalizeSlashes,
  setAllowedRootsCacheIfCurrent,
} from "../shared/allowed-roots";
import { listAllSessions } from "./session-reader";
export {
  allowFileRoot,
  normalizeSlashes,
  invalidateAllowedRootsCache,
  setAllowedRootsWatcherHealthy,
} from "../shared/allowed-roots";
export { canonicalPath, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access-core";

// Cache avoids re-scanning every session for each file request. The TTL is
// watcher-aware (see allowed-roots.ts): long when the session watcher delivers
// event-driven invalidation, short as a fallback when it cannot.
export async function getAllowedFileRoots(): Promise<Set<string>> {
  const cached = getAllowedRootsCache();
  if (cached && cached.expiresAt > Date.now()) return cached.roots;

  const generation = getAllowedRootsGeneration();
  let roots = await scanAllowedFileRoots();
  if (setAllowedRootsCacheIfCurrent({ roots, expiresAt: Date.now() + allowedRootsCacheTtlMs() }, generation)) {
    return roots;
  }

  // The watcher invalidated the cache while listAllSessions() was in flight.
  // Retry once for the current caller. A second collision remains uncached, so
  // it cannot leave stale roots in place for the long watcher-backed TTL.
  const retryGeneration = getAllowedRootsGeneration();
  roots = await scanAllowedFileRoots();
  setAllowedRootsCacheIfCurrent({ roots, expiresAt: Date.now() + allowedRootsCacheTtlMs() }, retryGeneration);
  return roots;
}

async function scanAllowedFileRoots(): Promise<Set<string>> {
  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);
  return roots;
}
