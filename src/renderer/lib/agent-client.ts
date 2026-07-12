// Client-side helper for agent commands (replaces POST /api/agent/[id]).
import { agentCommand } from "./api-client";

export async function sendAgentCommand<T = unknown>(sessionId: string, command: Record<string, unknown>): Promise<T> {
  return agentCommand(sessionId, command) as Promise<T>;
}
