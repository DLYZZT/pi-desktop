import type { AgentMessage, SessionEntry } from "../shared/types";

/** Pi records a null context edit for an omitted attempt. Only a later assistant in that turn supersedes its failure. */
export function supersededAttempts(path: SessionEntry[]): Set<string> {
  const omitted = new Set<string>();
  const superseded = new Set<string>();
  let laterAssistant = false;
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (entry.type === "context_edit" && entry.replacement === null) omitted.add(entry.targetId);
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") laterAssistant = false;
    if (entry.message.role !== "assistant") continue;
    if (laterAssistant && entry.message.stopReason === "error" && omitted.has(entry.id)) superseded.add(entry.id);
    laterAssistant = true;
  }
  return superseded;
}
export function withoutSupersededFailure(message: AgentMessage | null, superseded: boolean): AgentMessage | null {
  if (!superseded || message?.role !== "assistant") return message;
  return message.content.length ? { ...message, stopReason: undefined, errorMessage: undefined } : null;
}
