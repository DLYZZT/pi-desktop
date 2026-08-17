export function forkOnSelectSession(session: { id?: string; cwd?: string }): void {
  const sessionId = session.id?.trim();
  const cwd = session.cwd?.trim();
  if (!sessionId || !cwd) return;
  window.piBridge.startSessionTui?.({ sessionId, cwd });
}
