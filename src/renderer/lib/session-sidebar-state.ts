import type { SessionInfo } from "./types";
import { getRecentProjects } from "./session-list.ts";
import { worktreePathsEqual } from "../../shared/worktree-path.ts";

import type { Streams } from "@contract/api";

export type SessionChangedEvent = Streams["sessions.changed"];

export function applySessionChangedEvent(sessions: SessionInfo[], event: SessionChangedEvent): SessionInfo[] | null {
  if (event.fullRefresh) return null;
  if (event.deleted && event.sessionId) return sessions.filter((session) => session.id !== event.sessionId);
  if (!event.session) return null;
  const next = sessions.filter((session) => session.id !== event.session!.id);
  next.push(event.session);
  next.sort((left, right) => right.modified.localeCompare(left.modified));
  return next;
}

/**
 * Project the window context moves to after a project is removed: the most
 * recent remaining project (remembered session-less ones included), or null
 * when the removed project was the last one.
 */
export function resolveProjectRemovalFallback(
  sessions: readonly SessionInfo[],
  removedProjectRoot: string,
  rememberedRoots: readonly string[],
): string | null {
  const candidates = [...getRecentProjects(sessions), ...rememberedRoots];
  return candidates.find((root) => !worktreePathsEqual(root, removedProjectRoot)) ?? null;
}
