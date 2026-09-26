import type { RpcServer } from "../contract/rpc";
import { resolveSessionPath } from "./session-reader";
import { sessionIndex } from "./session-index";

export async function emitIndexedSessionChange(
  server: Pick<RpcServer, "emit">,
  sessionId: string,
  cwd: string | null,
): Promise<void> {
  try {
    const filePath = await resolveSessionPath(sessionId);
    const session = filePath ? await sessionIndex.refreshPath(filePath) : null;
    if (session) {
      server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
      return;
    }
  } catch (error) {
    console.error("[agent-host] failed to refresh changed session:", error);
  }
  server.emit("sessions.changed", "*", { cwd, fullRefresh: true });
}
