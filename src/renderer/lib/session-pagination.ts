import type { PagedContextInfo } from "@contract/types";
import type { AgentMessage } from "./types";

export interface LoadedHistory {
  messages: AgentMessage[];
  entryIds: string[];
  revision: string | null;
  previousCursor: string | null;
}

function fromPage(context: PagedContextInfo): LoadedHistory {
  return {
    messages: context.messages,
    entryIds: context.entryIds,
    revision: context.historyRevision,
    previousCursor: context.previousCursor ?? null,
  };
}

export function mergeHistoryTail(current: LoadedHistory, context: PagedContextInfo, reset = false): LoadedHistory {
  if (reset || current.revision !== context.historyRevision || current.entryIds.length === 0) {
    return fromPage(context);
  }
  if (context.entryIds.length === 0) return current;
  const currentIndexById = new Map(current.entryIds.map((entryId, index) => [entryId, index]));
  const firstOverlapInTail = context.entryIds.findIndex((entryId) => currentIndexById.has(entryId));
  if (firstOverlapInTail === -1) return fromPage(context);
  const overlapCurrentIndex = currentIndexById.get(context.entryIds[firstOverlapInTail]) ?? 0;
  return {
    messages: [...current.messages.slice(0, overlapCurrentIndex), ...context.messages.slice(firstOverlapInTail)],
    entryIds: [...current.entryIds.slice(0, overlapCurrentIndex), ...context.entryIds.slice(firstOverlapInTail)],
    revision: current.revision,
    previousCursor: current.previousCursor,
  };
}

export function prependHistoryPage(current: LoadedHistory, context: PagedContextInfo): LoadedHistory | null {
  if (current.revision !== context.historyRevision) return null;
  const existingIds = new Set(current.entryIds);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  context.entryIds.forEach((entryId, index) => {
    if (existingIds.has(entryId)) return;
    entryIds.push(entryId);
    messages.push(context.messages[index]);
  });
  return {
    messages: [...messages, ...current.messages],
    entryIds: [...entryIds, ...current.entryIds],
    revision: current.revision,
    previousCursor: context.previousCursor ?? null,
  };
}
