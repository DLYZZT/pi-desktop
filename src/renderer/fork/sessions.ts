import type { SessionInfo } from "../lib/types.ts";
import { filterSessionsForQuery } from "../lib/session-list.ts";

export function sessionProjectRoot(session: SessionInfo): string {
  return session.projectRoot ?? session.cwd ?? "";
}

export function sessionProjectLabel(session: SessionInfo): string {
  const root = sessionProjectRoot(session).replace(/[\\/]+$/, "");
  if (!root) return "";
  const parts = root.split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

export type ProjectFolder = {
  root: string;
  label: string;
  sessions: SessionInfo[];
  archivedCount?: number;
};

export function groupSessionsByProject(sessions: SessionInfo[]): ProjectFolder[] {
  const buckets = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const root = sessionProjectRoot(session) || "(no project)";
    const list = buckets.get(root) ?? [];
    list.push(session);
    buckets.set(root, list);
  }
  return [...buckets.entries()]
    .map(([root, folderSessions]) => ({
      root,
      label: sessionProjectLabel(folderSessions[0]!) || root,
      sessions: folderSessions,
    }))
    .sort((left, right) => {
      const latest = (folder: ProjectFolder) =>
        folder.sessions.reduce((max, session) => (session.modified > max ? session.modified : max), "");
      return latest(right).localeCompare(latest(left));
    });
}

export function projectFoldersForSidebar(sessions: SessionInfo[], sessionFilter = ""): ProjectFolder[] {
  const query = sessionFilter.trim();
  return groupSessionsByProject(sessions)
    .map((folder) => ({
      ...folder,
      archivedCount: folder.sessions.filter((session) => session.archived).length,
      sessions: filterSessionsForSidebar(folder.sessions, { archived: false, query: sessionFilter }),
    }))
    .filter((folder) => (query ? folder.sessions.length > 0 : folder.sessions.length > 0 || folder.archivedCount > 0));
}

export function filterSessionsForSidebar(
  sessions: SessionInfo[],
  options: { archived: boolean; projectRoot?: string | null; query?: string },
): SessionInfo[] {
  const scoped = sessions.filter((session) => Boolean(session.archived) === options.archived);
  const byProject = options.projectRoot
    ? scoped.filter((session) => sessionProjectRoot(session) === options.projectRoot)
    : scoped;
  return filterSessionsForQuery(byProject, options.query ?? "");
}
