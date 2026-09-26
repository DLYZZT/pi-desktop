import { realpathSync, statSync } from "node:fs";
import path from "node:path";

type DirectoryValidation = { ok: true; path: string; canonicalPath: string } | { ok: false; error: string };

export function validateExistingDirectory(candidate: unknown): DirectoryValidation {
  if (typeof candidate !== "string" || !candidate) return { ok: false, error: "Directory does not exist" };
  try {
    const realpath = realpathSync.native ?? realpathSync;
    const canonicalPath = realpath(candidate);
    if (!statSync(canonicalPath).isDirectory()) return { ok: false, error: "Not a directory" };
    return { ok: true, path: candidate, canonicalPath };
  } catch {
    return { ok: false, error: "Directory does not exist" };
  }
}

export function canonicalPathForComparison(candidate: string): string {
  const resolved = path.resolve(candidate);
  let canonical = resolved;
  try {
    const realpath = realpathSync.native ?? realpathSync;
    canonical = realpath(resolved);
  } catch {
    // Historical session cwd values can refer to directories that no longer exist.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
