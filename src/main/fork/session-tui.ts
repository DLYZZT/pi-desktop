export const sessionTuiLive = new Set<string>();

export type SessionTuiSelectInput = {
  sessionId: string;
  cwd: string;
};

export type SessionTuiSpawnRequest = {
  action: "spawn";
  sessionId: string;
  cwd: string;
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
};

export function applySessionTuiSelect(
  session: SessionTuiSelectInput,
  bundled: { bundledPi: string },
  port: SessionTuiProcessPort,
  live: Set<string> = new Set(),
): SessionTuiAction {
  if (live.has(session.sessionId)) {
    const request: SessionTuiFocusRequest = { action: "focus", sessionId: session.sessionId };
    port.focus(request);
    return request;
  }
  const request: SessionTuiSpawnRequest = {
    action: "spawn",
    sessionId: session.sessionId,
    cwd: session.cwd,
    program: bundled.bundledPi,
    args: ["--session", session.sessionId],
  };
  port.spawn(request);
  live.add(session.sessionId);
  return request;
}

export function applySessionTuiQuit(live: Set<string>, port: { killAll: (sessionIds: string[]) => void }): void {
  port.killAll([...live]);
  live.clear();
}
