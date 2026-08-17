export function forkOnSelectSession(session: { id?: string; path?: string; cwd?: string }): void {
  const sessionId = session.id?.trim();
  const sessionPath = session.path?.trim();
  const cwd = session.cwd?.trim();
  if (!sessionId || !cwd) return;
  window.piBridge.startSessionTui?.({ sessionId, ...(sessionPath ? { sessionPath } : {}), cwd });
}

export function forkOnNewSession(sessionId: string, cwd: string): void {
  forkOnSelectSession({ id: sessionId, cwd });
}
