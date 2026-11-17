import type { SessionInfo } from "./types";
import { normalizeWorktreePathForComparison, worktreePathsEqual } from "../../shared/worktree-path.ts";

export type SessionDateGroup = "today" | "recent" | "older";

export type InitialSessionRestoreDecision =
  { status: "wait" | "none" | "not-found" } | { status: "restore"; session: SessionInfo };

export function resolveInitialSessionRestore(
  sessions: SessionInfo[],
  initialSessionId: string | null | undefined,
  loading: boolean,
  hasLoadError: boolean,
  alreadyRestored: boolean,
): InitialSessionRestoreDecision {
  if (loading || hasLoadError) return { status: "wait" };
  if (!initialSessionId || alreadyRestored) return { status: "none" };
  const session = sessions.find((item) => item.id === initialSessionId);
  return session ? { status: "restore", session } : { status: "not-found" };
}

export function getSessionDisplayTitle(session: SessionInfo, maxLength = 72): string {
  const source = session.name?.trim() || session.firstMessage?.trim() || session.id;
  const normalized = source.replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function sessionDateGroup(modified: string, now = new Date()): SessionDateGroup {
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return "older";

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const recentStart = new Date(todayStart);
  recentStart.setDate(recentStart.getDate() - 6);

  if (date >= todayStart) return "today";
  if (date >= recentStart) return "recent";
  return "older";
}

export function filterSessionsForQuery(sessions: SessionInfo[], rawQuery: string): SessionInfo[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return sessions;

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const visibleIds = new Set<string>();

  for (const session of sessions) {
    const searchText = [session.name, session.firstMessage, session.id, session.cwd, session.worktreeBranch]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase();
    if (!searchText.includes(query)) continue;

    visibleIds.add(session.id);
    let parentId = session.parentSessionId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      visibleIds.add(parent.id);
      parentId = parent.parentSessionId;
    }
  }

  return sessions.filter((session) => visibleIds.has(session.id));
}

/**
 * Every session that belongs to the project, across all of its worktrees.
 * Removing a project deletes exactly these session records.
 */
export function collectProjectSessions(sessions: readonly SessionInfo[], projectRoot: string): SessionInfo[] {
  return sessions.filter((session) => {
    const root = session.projectRoot ?? session.cwd;
    return Boolean(root) && worktreePathsEqual(root, projectRoot);
  });
}

/**
 * Return all projects (deduped by normalized path so worktrees and spelling
 * drift collapse into their main repo) sorted by most recent session activity.
 */
export function getRecentProjects(sessions: readonly SessionInfo[]): string[] {
  const latestByRoot = new Map<string, { display: string; modified: string }>(); // normalized root -> latest
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const key = normalizeWorktreePathForComparison(root);
    const prev = latestByRoot.get(key);
    if (!prev || s.modified > prev.modified) {
      latestByRoot.set(key, { display: root, modified: s.modified });
    }
  }
  return [...latestByRoot.values()].sort((a, b) => b.modified.localeCompare(a.modified)).map((entry) => entry.display);
}

export interface SessionProjectGroup {
  /** Main repo root shared by all worktrees of the project (cwd for non-git dirs). */
  projectRoot: string;
  sessions: SessionInfo[];
  /** Most recent `modified` in the group — drives group ordering. */
  latestModified: string;
}

/**
 * Group sessions by project (worktrees of one repo collapse into their main
 * checkout), most recently active project first. Sessions without any usable
 * path are dropped, mirroring getRecentProjects.
 *
 * Bucketing compares normalized paths: resolveProject falls back to the raw
 * session cwd when git fails, so one project can surface both spellings
 * (git's forward slashes vs the session header's backslashes on Windows) and
 * string keys would split it into two groups.
 */
export function groupSessionsByProject(sessions: SessionInfo[]): SessionProjectGroup[] {
  const byRoot = new Map<string, SessionProjectGroup>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const bucket = byRoot.get(normalizeWorktreePathForComparison(root));
    if (bucket) {
      bucket.sessions.push(session);
      if (session.modified > bucket.latestModified) bucket.latestModified = session.modified;
    } else {
      byRoot.set(normalizeWorktreePathForComparison(root), {
        projectRoot: root,
        sessions: [session],
        latestModified: session.modified,
      });
    }
  }
  return [...byRoot.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

/**
 * Projects that must appear in aggregated mode without any sessions: the
 * active project (so a freshly opened one shows up immediately) plus projects
 * opened earlier, most recent first. The active project leads so it is easy to
 * spot; session-backed groups render ahead of these.
 */
export function resolveEmptyProjectRoots(
  sessionRoots: readonly string[],
  selectedProject: string | null,
  knownRoots: readonly string[],
): string[] {
  const extras: string[] = [];
  const seen = (root: string) =>
    sessionRoots.some((existing) => worktreePathsEqual(existing, root)) ||
    extras.some((existing) => worktreePathsEqual(existing, root));
  const add = (root: string | null) => {
    if (root && !seen(root)) extras.push(root);
  };
  add(selectedProject);
  for (const root of knownRoots) add(root);
  return extras;
}
