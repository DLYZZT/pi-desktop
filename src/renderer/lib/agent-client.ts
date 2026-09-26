import { agentCommand } from "./api-client";
import type { BuiltinAgentCommand, BuiltinAgentCommandResult } from "@contract/agent-commands";

export async function sendAgentCommand<C extends BuiltinAgentCommand>(
  sessionId: string,
  command: C,
): Promise<BuiltinAgentCommandResult<C>> {
  // The wire endpoint deliberately stays open/unknown. This is the single
  // result assertion for the desktop command table implemented by the Host.
  return agentCommand(sessionId, command) as Promise<BuiltinAgentCommandResult<C>>;
}
