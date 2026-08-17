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

export type SessionTuiProcessPort = {
  spawn: (request: SessionTuiSpawnRequest) => void;
};

export function applySessionTuiSelect(
  session: SessionTuiSelectInput,
  bundled: { bundledPi: string },
  port: SessionTuiProcessPort,
): SessionTuiSpawnRequest {
  const request: SessionTuiSpawnRequest = {
    action: "spawn",
    sessionId: session.sessionId,
    cwd: session.cwd,
    program: bundled.bundledPi,
    args: ["--session", session.sessionId],
  };
  port.spawn(request);
  return request;
}
