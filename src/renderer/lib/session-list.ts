import type { SessionInfo } from "./types";

export type SessionDateGroup = "today" | "recent" | "older";

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
