import type { SessionInfo } from "./types";

export type SessionChangedEvent = {
  cwd: string | null;
  sessionId?: string;
  session?: SessionInfo;
  deleted?: boolean;
  fullRefresh?: boolean;
};

export function applySessionChangedEvent(sessions: SessionInfo[], event: SessionChangedEvent): SessionInfo[] | null {
  if (event.fullRefresh) return null;
  if (event.deleted && event.sessionId) return sessions.filter((session) => session.id !== event.sessionId);
  if (!event.session) return null;
  const next = sessions.filter((session) => session.id !== event.session!.id);
  next.push(event.session);
  next.sort((left, right) => right.modified.localeCompare(left.modified));
  return next;
}
