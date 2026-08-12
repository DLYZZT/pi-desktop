import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export interface ToolMessageData {
  results: ReadonlyMap<string, ToolResultMessage>;
  durations: ReadonlyMap<string, number>;
}

const EMPTY_TOOL_DATA: ToolMessageData = {
  results: new Map(),
  durations: new Map(),
};

export function buildToolMessageIndex(messages: AgentMessage[]): ReadonlyMap<AgentMessage, ToolMessageData> {
  const resultsById = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") resultsById.set(message.toolCallId, message as ToolResultMessage);
  }

  const byMessage = new Map<AgentMessage, ToolMessageData>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    const results = new Map<string, ToolResultMessage>();
    const durations = new Map<string, number>();
    for (const block of assistant.content ?? []) {
      if (block.type !== "toolCall") continue;
      const callId = (block as ToolCallContent).toolCallId;
      const result = resultsById.get(callId);
      if (!result) continue;
      results.set(callId, result);
      if (assistant.timestamp && result.timestamp) {
        const seconds = Math.round((result.timestamp - assistant.timestamp) / 1_000);
        if (seconds > 0) durations.set(callId, seconds);
      }
    }
    byMessage.set(message, results.size > 0 ? { results, durations } : EMPTY_TOOL_DATA);
  }
  return byMessage;
}
