import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export interface ToolMessageData {
  results: ReadonlyMap<string, ToolResultMessage>;
  durations: ReadonlyMap<string, number>;
}

const EMPTY_TOOL_DATA: ToolMessageData = {
  results: new Map(),
  durations: new Map(),
};

function sameEntries<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  return left.size === right.size && [...left].every(([id, value]) => right.has(id) && right.get(id) === value);
}

export class ToolMessageIndex {
  private previous: ReadonlyMap<AgentMessage, ToolMessageData> = new Map();

  build(messages: AgentMessage[]): ReadonlyMap<AgentMessage, ToolMessageData> {
    this.previous = buildToolMessageIndex(messages, this.previous);
    return this.previous;
  }
}

export function buildToolMessageIndex(
  messages: AgentMessage[],
  previous?: ReadonlyMap<AgentMessage, ToolMessageData>,
): ReadonlyMap<AgentMessage, ToolMessageData> {
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
    const cached = previous?.get(message);
    byMessage.set(
      message,
      results.size === 0
        ? EMPTY_TOOL_DATA
        : cached && sameEntries(cached.results, results) && sameEntries(cached.durations, durations)
          ? cached
          : { results, durations },
    );
  }
  return byMessage;
}
