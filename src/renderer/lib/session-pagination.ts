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

/** RPC clones JSON values; retain an existing message only when every field agrees. */
function sameMessageValue(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  const seen = new WeakMap<object, object>();
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    if (!Array.isArray(a) && ![Object.prototype, null].includes(Object.getPrototypeOf(a))) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a) === b) continue;
    seen.set(a, b);
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
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
  const tail = context.messages.slice(firstOverlapInTail).map((incoming, offset) => {
    const previousIndex = currentIndexById.get(context.entryIds[firstOverlapInTail + offset]);
    const previous = previousIndex === undefined ? undefined : current.messages[previousIndex];
    return previous && sameMessageValue(previous, incoming) ? previous : incoming;
  });
  const messages = [...current.messages.slice(0, overlapCurrentIndex), ...tail];
  const entryIds = [...current.entryIds.slice(0, overlapCurrentIndex), ...context.entryIds.slice(firstOverlapInTail)];
  if (
    messages.length === current.messages.length &&
    messages.every(
      (message, index) => message === current.messages[index] && entryIds[index] === current.entryIds[index],
    )
  )
    return current;
  return {
    messages,
    entryIds,
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
