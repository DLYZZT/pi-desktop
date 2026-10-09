import { worktreePathsEqual } from "../../shared/worktree-path.ts";

export const KNOWN_PROJECTS_STORAGE_KEY = "pi-desktop:known-projects";

/** Keep the list bounded; the most recently opened projects survive. */
export const MAX_KNOWN_PROJECTS = 30;

export type ProjectStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseRoots(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * Projects the user has opened, most recent first. Aggregated mode keeps
 * session-less projects listed so opening one does not make it vanish as soon
 * as another project is opened.
 */
export function loadKnownProjectRoots(storage: ProjectStorage): string[] {
  return parseRoots(storage.getItem(KNOWN_PROJECTS_STORAGE_KEY)).slice(0, MAX_KNOWN_PROJECTS);
}

export function saveKnownProjectRoots(storage: ProjectStorage, roots: readonly string[]): void {
  const bounded = roots.slice(0, MAX_KNOWN_PROJECTS);
  if (bounded.length === 0) storage.removeItem(KNOWN_PROJECTS_STORAGE_KEY);
  else storage.setItem(KNOWN_PROJECTS_STORAGE_KEY, JSON.stringify(bounded));
}

/** Move the project to the front, deduped by path equality, within the cap. */
export function addKnownProjectRoot(roots: readonly string[], projectRoot: string): string[] {
  if (!projectRoot) return [...roots];
  const next = [projectRoot, ...roots.filter((root) => !worktreePathsEqual(root, projectRoot))];
  return next.slice(0, MAX_KNOWN_PROJECTS);
}

/** Drop paths that no longer exist on disk (batch results come back unordered). */
export function pruneKnownProjectRoots(roots: readonly string[], existing: readonly string[]): string[] {
  return roots.filter((root) => existing.some((candidate) => worktreePathsEqual(candidate, root)));
}
