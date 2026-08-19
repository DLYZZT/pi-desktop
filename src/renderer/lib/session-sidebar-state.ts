import type { SessionInfo } from "./types";

export type SessionChangedEvent = {
  cwd: string | null;
  sessionId?: string;
  session?: SessionInfo;
  deleted?: boolean;
  fullRefresh?: boolean;
};

export function isSessionWorking(
  sessionId: string,
  runningSessionIds: Set<string>,
  tuiWorkingSessionIds: Set<string>,
  tuiMark?: "running" | "dead",
): boolean {
  if (runningSessionIds.has(sessionId)) return true;
  if (tuiMark === "dead") return false;
  return tuiWorkingSessionIds.has(sessionId);
}

export function nextTuiWorkingSessionIds(current: Set<string>, sessionId: string, live: boolean): Set<string> {
  const has = current.has(sessionId);
  if (live === has) return current;
  const next = new Set(current);
  if (live) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}

export function applySessionChangedEvent(sessions: SessionInfo[], event: SessionChangedEvent): SessionInfo[] | null {
  if (event.fullRefresh) return null;
  if (event.deleted && event.sessionId) return sessions.filter((session) => session.id !== event.sessionId);
  if (!event.session) return null;
  const next = sessions.filter((session) => session.id !== event.session!.id);
  next.push(event.session);
  next.sort((left, right) => right.modified.localeCompare(left.modified));
  return next;
}
