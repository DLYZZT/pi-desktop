export type SessionTuiMark = "running" | "dead";

export type SessionTuiMarks = Map<string, SessionTuiMark>;

export const sessionTuiMarks: SessionTuiMarks = new Map();

export type SessionTuiSelectInput = {
  sessionId: string;
  sessionPath?: string;
  cwd: string;
};

export type SessionTuiSpawnRequest = {
  action: "spawn";
  sessionId: string;
  cwd: string;
  nodeExecutable: string;
  program: string;
  args: string[];
};

export type SessionTuiFocusRequest = {
  action: "focus";
  sessionId: string;
};

export type SessionTuiAction = SessionTuiSpawnRequest | SessionTuiFocusRequest;

export type SessionTuiProcessPort = {
  spawn: (request: SessionTuiSpawnRequest) => void;
  focus: (request: SessionTuiFocusRequest) => void;
  kill?: (sessionIds: string[]) => void;
};

export function sessionTuiMarkOf(marks: SessionTuiMarks, sessionId: string): SessionTuiMark | null {
  return marks.get(sessionId) ?? null;
}

export function applySessionTuiSelect(
  session: SessionTuiSelectInput,
  bundled: { bundledPi: string; nodeExecutable: string },
  port: SessionTuiProcessPort,
  marks: SessionTuiMarks = new Map(),
): SessionTuiAction {
  if (marks.get(session.sessionId) === "running") {
    const request: SessionTuiFocusRequest = { action: "focus", sessionId: session.sessionId };
    port.focus(request);
    return request;
  }
  const request: SessionTuiSpawnRequest = {
    action: "spawn",
    sessionId: session.sessionId,
    cwd: session.cwd,
    nodeExecutable: bundled.nodeExecutable,
    program: bundled.bundledPi,
    args: ["--session", session.sessionPath || session.sessionId],
  };
  port.spawn(request);
  marks.set(session.sessionId, "running");
  return request;
}

export function applySessionTuiKill(
  sessionId: string,
  marks: SessionTuiMarks,
  port: Pick<SessionTuiProcessPort, "kill">,
): void {
  port.kill?.([sessionId]);
  marks.set(sessionId, "dead");
}

export function applySessionTuiExited(sessionId: string, marks: SessionTuiMarks): void {
  if (marks.has(sessionId)) marks.set(sessionId, "dead");
}

export function applySessionTuiQuit(marks: SessionTuiMarks, port: { killAll: (sessionIds: string[]) => void }): void {
  const running = [...marks].filter(([, mark]) => mark === "running").map(([sessionId]) => sessionId);
  port.killAll(running);
  marks.clear();
}

export function snapshotSessionTuiMarks(marks: SessionTuiMarks): Record<string, SessionTuiMark> {
  return Object.fromEntries(marks);
}

export function reconcileSessionTuiMarks(marks: SessionTuiMarks, aliveIds: Iterable<string>): void {
  const alive = new Set(aliveIds);
  for (const [sessionId, mark] of marks) {
    if (mark === "running" && !alive.has(sessionId)) marks.set(sessionId, "dead");
  }
  for (const sessionId of alive) marks.set(sessionId, "running");
}
