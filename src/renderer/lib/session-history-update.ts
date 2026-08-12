import type { AgentMessage } from "./types";

export interface SessionHistoryValue {
  messages: AgentMessage[];
  entryIds: string[];
}

export function normalizeSessionHistory(messages: AgentMessage[], entryIds: string[]): SessionHistoryValue {
  if (entryIds.length === messages.length) return { messages, entryIds };
  return {
    messages,
    entryIds: Array.from({ length: messages.length }, (_, index) => entryIds[index] ?? ""),
  };
}

export function appendLocalHistoryMessage(history: SessionHistoryValue, message: AgentMessage): SessionHistoryValue {
  const current = normalizeSessionHistory(history.messages, history.entryIds);
  return { messages: [...current.messages, message], entryIds: [...current.entryIds, ""] };
}

export function replaceLastHistoryMessage(history: SessionHistoryValue, message: AgentMessage): SessionHistoryValue {
  const current = normalizeSessionHistory(history.messages, history.entryIds);
  if (current.messages.length === 0) return appendLocalHistoryMessage(current, message);
  return { messages: [...current.messages.slice(0, -1), message], entryIds: current.entryIds };
}

export function removeLastHistoryMessage(history: SessionHistoryValue): SessionHistoryValue {
  const current = normalizeSessionHistory(history.messages, history.entryIds);
  return { messages: current.messages.slice(0, -1), entryIds: current.entryIds.slice(0, -1) };
}
