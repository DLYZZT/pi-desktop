import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  getAdditionalAllowedRoots,
  getAllowedRootsCache,
  normalizeSlashes,
  setAllowedRootsCache,
} from "../shared/allowed-roots";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes, invalidateAllowedRootsCache } from "../shared/allowed-roots";
export { canonicalPath, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access-core";

// Short-TTL cache avoids re-scanning every session for each file request while
// allowing newly created working directories to appear promptly.

const ALLOWED_ROOTS_TTL_MS = 5_000;
export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = getAllowedRootsCache();
  if (cached && cached.expiresAt > now) return cached.roots;

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

  setAllowedRootsCache({ roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
  return roots;
}
