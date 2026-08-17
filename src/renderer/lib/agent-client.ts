// Client-side helper for agent commands (replaces POST /api/agent/[id]).
import { agentCommand } from "./api-client";

export async function sendAgentCommand<T = unknown>(sessionId: string, command: Record<string, unknown>): Promise<T> {
  return agentCommand(sessionId, command) as Promise<T>;
}

/** Stop a turn without waiting on agent.command RPC. */
export function abortAgentSession(sessionId: string): void {
  const bridge = typeof window !== "undefined" ? window.piBridge : undefined;
  if (bridge?.abortSession) {
    bridge.abortSession(sessionId);
    return;
  }
  void sendAgentCommand(sessionId, { type: "abort" }).catch((error) => {
    console.error("Failed to abort:", error);
  });
}
