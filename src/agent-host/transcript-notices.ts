import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, SessionEntry } from "../shared/types";
import type { NoticePreferences, TranscriptNotice } from "../shared/transcript-notices";
import { collectCacheMisses, detectCacheMiss } from "./pi-sdk-core";

function droppedReasoning(
  message: AssistantMessage,
): Extract<TranscriptNotice, { kind: "reasoningDrops" }> | undefined {
  if (!Array.isArray(message.diagnostics)) return;
  for (const diagnostic of message.diagnostics) {
    const openAI = diagnostic?.type === "openai_input_transformations";
    if (!openAI && diagnostic?.type !== "anthropic_input_transformations") continue;
    const items = (diagnostic.details as { transformations?: unknown } | null)?.transformations;
    if (!Array.isArray(items)) continue;
    const dropped = items.filter((item) => item?.type === (openAI ? "reasoning" : "thinking_dropped"));
    if (dropped.length)
      return {
        kind: "reasoningDrops",
        provider: openAI ? "OpenAI" : "Anthropic",
        count: dropped.length,
        reasons: [
          ...new Set<string>(
            dropped.flatMap((item) => (typeof item.reason === "string" ? [item.reason.slice(0, 96)] : [])),
          ),
        ].slice(0, 8),
      };
  }
}

/** Entries whose usage cache-miss detection can read. Shared by the history projection and the live check. */
function hasCacheUsage(entry: SessionEntry) {
  return entry.type === "message" && entry.message.role === "assistant"
    ? Boolean(entry.message.usage?.cost)
    : entry.type !== "usage" || Boolean(entry.usage?.cost);
}
// Notices show token counts only, so the catalog read price is not needed.
const noPrices = { getModel: () => undefined };

/** Derive once for the whole selected branch, before slicing pages. No notice is written into the session. */
export function branchTranscriptNotices(branch: SessionEntry[], settings: NoticePreferences) {
  const notices = new Map<string, TranscriptNotice[]>();
  const misses = settings.cacheMisses ? collectCacheMisses(branch.filter(hasCacheUsage), noPrices) : undefined;
  let previous: ReturnType<typeof droppedReasoning>;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const current = settings.reasoningDrops ? droppedReasoning(entry.message) : undefined;
      const items: TranscriptNotice[] = [];
      if (current && (current.provider !== previous?.provider || current.count > previous.count)) items.push(current);
      previous = current;
      const miss = misses?.get(entry.message);
      if (miss) items.push({ kind: "cacheMisses", tokens: miss.missedTokens });
      if (items.length) notices.set(entry.id, items);
    } else if (
      (settings.cacheWarming && entry.type === "usage" && entry.kind === "cache_warm") ||
      (settings.compactionCosts && (entry.type === "compaction" || entry.type === "branch_summary"))
    ) {
      const usage = entry.usage;
      if (!usage?.cost) continue;
      notices.set(entry.id, [
        {
          kind: entry.type === "usage" ? "cacheWarming" : "compactionCosts",
          tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          cost: usage.cost.total,
          ...(entry.type === "branch_summary" ? { branchSummary: true } : {}),
        },
      ]);
    }
  }
  return notices;
}

type BranchReader = Pick<SessionManager, "getLeafEntry" | "getEntry">;
type LiveNoticeSource = {
  settingsManager?: { getNotices?: () => NoticePreferences };
  sessionManager?: BranchReader;
};

interface PriorRequests {
  assistant?: AssistantMessage;
  lastRequest?: SessionEntry;
  lastCachedRequest?: SessionEntry;
}

function advance(state: PriorRequests, entry: SessionEntry) {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    state.lastRequest = state.lastCachedRequest = undefined;
    return;
  }
  const assistant = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
  if (assistant) state.assistant = assistant;
  const warming = entry.type === "usage" && entry.kind === "cache_warm";
  const usage = warming ? entry.usage : assistant?.usage;
  if (!usage?.cost || usage.input + usage.cacheRead + usage.cacheWrite <= 0) return;
  state.lastRequest = entry;
  if (warming || usage.cacheRead + usage.cacheWrite > 0) state.lastCachedRequest = entry;
}

// SDK entry objects are append-only. Cache only the last active ancestry, rebuilding it when a
// navigation or a replaced history breaks the chain. No per-entry or global transcript copy is kept.
const tails = new WeakMap<BranchReader, { leaf: SessionEntry | undefined; state: PriorRequests }>();

function priorRequests(manager: BranchReader, finishing: AssistantMessage): PriorRequests {
  let leaf = manager.getLeafEntry() as SessionEntry | undefined;
  const parent = (entry: SessionEntry) =>
    entry.parentId ? (manager.getEntry(entry.parentId) as SessionEntry | undefined) : undefined;
  // Pi emits message_end before append. If a caller already appended it, skip only that very object.
  if (leaf?.type === "message" && leaf.message === finishing) leaf = parent(leaf);
  const last = tails.get(manager);
  if (last && last.leaf === leaf) return last.state;
  const additions: SessionEntry[] = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor && cursor !== last?.leaf && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    additions.push(cursor);
    cursor = parent(cursor);
  }
  const state: PriorRequests = last && cursor === last.leaf ? { ...last.state } : {};
  for (let i = additions.length - 1; i >= 0; i--) advance(state, additions[i]);
  tails.set(manager, { leaf, state });
  return state;
}

function assistantAddsNotice(message: AssistantMessage, flags: NoticePreferences, manager: BranchReader) {
  const current = flags.reasoningDrops ? droppedReasoning(message) : undefined;
  if (!current && !(flags.cacheMisses && message.usage?.cost)) return false;
  const prior = priorRequests(manager, message);
  if (current) {
    const previous = prior.assistant && droppedReasoning(prior.assistant);
    if (current.provider !== previous?.provider || current.count > previous.count) return true;
  }
  if (!flags.cacheMisses || !message.usage?.cost || !prior.lastRequest) return false;
  // Pi needs the last billed prompt plus evidence of any earlier cache activity since the last
  // compaction/branch summary. Its own helper applies the noise floor and cache-hit calculation.
  const samples =
    prior.lastCachedRequest && prior.lastCachedRequest !== prior.lastRequest
      ? [prior.lastCachedRequest, prior.lastRequest]
      : [prior.lastRequest];
  return Boolean(detectCacheMiss(samples, message, noPrices));
}

/** Refresh the durable projection only when the event contributes a visible notice. */
export function needsTranscriptRefresh(event: { type: string; [key: string]: unknown }, source: LiveNoticeSource = {}) {
  if (event.type === "message_end") {
    const message = event.message as AssistantMessage | undefined;
    if (message?.role !== "assistant" || !source.sessionManager?.getLeafEntry || !source.sessionManager.getEntry)
      return false;
    const flags = source.settingsManager?.getNotices?.();
    return Boolean(flags && assistantAddsNotice(message, flags, source.sessionManager));
  }
  if (event.type !== "entry_appended") return false;
  const entry = event.entry as SessionEntry | undefined;
  if (entry?.type === "usage" && entry.kind === "cache_warm" && entry.usage?.cost)
    return source.settingsManager?.getNotices?.().cacheWarming === true;
  return (
    (entry?.type === "compaction" || entry?.type === "branch_summary") &&
    Boolean(entry.usage?.cost) &&
    source.settingsManager?.getNotices?.().compactionCosts === true
  );
}
