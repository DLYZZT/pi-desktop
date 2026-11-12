import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { abortedAssistantEntryIds } from "./agent-settlement";
import type { HistoryWindow, PagedContextInfo } from "../contract/types";
import type {
  AgentMessage,
  DeferredContentRef,
  ImageContent,
  SessionEntry,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from "../shared/types";
import {
  buildSessionContext,
  entryToUiMessage,
  parseChannelSourceMarker,
  parseRunId,
  withUserMessageSource,
} from "./session-reader";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const RESPONSE_OVERHEAD_BYTES = 2048;

interface DeferStage {
  /** Content strictly larger than this many bytes is replaced by a preview. */
  thresholdBytes: number;
  previewBytes: number;
  /** Structured `details` have no textual preview, so only some stages omit them. */
  includeDetails: boolean;
}

// Standard previews: used for every page and for each message of a turn split across pages.
const STANDARD_STAGE: DeferStage = { thresholdBytes: 128 * 1024, previewBytes: 16 * 1024, includeDetails: true };
// Only used to keep a complete turn together, or for a single message that still does not fit.
const AGGRESSIVE_STAGE: DeferStage = { thresholdBytes: 4 * 1024, previewBytes: 2 * 1024, includeDetails: false };
// Last resort for one message whose fixed metadata and many small blocks exceed the page budget.
const MINIMAL_STAGE: DeferStage = { thresholdBytes: 512, previewBytes: 256, includeDetails: true };

interface HistoryCursorPayload {
  version: 1;
  historyRevision: string;
  anchorLeafId: string;
  beforeEntryId: string;
  anchorPathLength: number;
}

interface ProjectedMessage {
  message: AgentMessage;
  entryId: string;
  pathIndex: number;
}

interface ContentCandidate {
  bytes: number;
  details: boolean;
  defer: (previewBytes: number) => void;
}

interface CompactedMessages {
  messages: AgentMessage[];
  entryIds: string[];
  candidates: ContentCandidate[];
}

export class StaleHistoryCursorError extends Error {
  constructor(message = "Session history changed; reload the latest page") {
    super(message);
    this.name = "StaleHistoryCursorError";
  }
}

export function buildHistoryRevision(filePath: string, sessionId: string): string {
  const stat = statSync(filePath);
  const identity = `${sessionId}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  return createHash("sha256").update(identity).digest("base64url").slice(0, 18);
}

export function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeHistoryCursor(cursor: string): HistoryCursorPayload {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<HistoryCursorPayload>;
    if (
      value.version !== 1 ||
      typeof value.historyRevision !== "string" ||
      typeof value.anchorLeafId !== "string" ||
      typeof value.beforeEntryId !== "string" ||
      !Number.isSafeInteger(value.anchorPathLength) ||
      (value.anchorPathLength ?? 0) < 1
    ) {
      throw new Error("invalid shape");
    }
    return value as HistoryCursorPayload;
  } catch {
    throw new Error("Invalid session history cursor");
  }
}

function buildEntryPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  if (!current) return [];
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function deriveContextSettings(path: SessionEntry[]): Pick<PagedContextInfo, "thinkingLevel" | "model"> {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
}

function projectDisplayMessages(path: SessionEntry[]): ProjectedMessage[] {
  const projected: ProjectedMessage[] = [];
  const aborted = abortedAssistantEntryIds(path);
  let pendingChannelSource: ReturnType<typeof parseChannelSourceMarker> = null;
  path.forEach((entry, pathIndex) => {
    if (entry.type === "custom" && entry.customType === "pi-desktop-channel-source") {
      const marker = parseChannelSourceMarker(entry.data);
      if (marker) pendingChannelSource = marker;
      return;
    }
    if (entry.type === "custom" && entry.customType === "pi-desktop-channel-source-cancelled") {
      const runId = parseRunId(entry.data);
      if (!runId || pendingChannelSource?.runId === runId) pendingChannelSource = null;
      return;
    }
    let message = entryToUiMessage(entry);
    if (!message) return;
    if (message.role === "assistant" && aborted.has(entry.id)) message = { ...message, stopReason: "aborted" };
    if (message.role === "user") {
      message = withUserMessageSource(message, pendingChannelSource?.channel, pendingChannelSource?.attachments);
      pendingChannelSource = null;
    }
    projected.push({ message, entryId: entry.id, pathIndex });
  });
  return projected;
}

function groupTurns(messages: ProjectedMessage[]): ProjectedMessage[][] {
  const turns: ProjectedMessage[][] = [];
  let current: ProjectedMessage[] = [];
  for (const item of messages) {
    if (item.message.role === "user" && current.some((candidate) => candidate.message.role === "user")) {
      turns.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function cloneMessages(turn: ProjectedMessage[]): AgentMessage[] {
  return turn.map(({ message }) => {
    const cloned = { ...message } as AgentMessage;
    if (Array.isArray(message.content)) {
      cloned.content = message.content.map((block) => ({ ...block })) as AgentMessage["content"];
    }
    return cloned;
  });
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8Preview(text: string, previewBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= previewBytes) return text;
  let preview = buffer.subarray(0, previewBytes).toString("utf8");
  if (preview.endsWith("�")) preview = preview.slice(0, -1);
  return `${preview}\n\n… [content truncated; load full content]`;
}

function collectContentCandidates(messages: AgentMessage[], entryIds: string[]): ContentCandidate[] {
  const candidates: ContentCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    const entryId = entryIds[messageIndex];
    if ((message.role === "toolResult" || message.role === "custom") && message.details !== undefined) {
      const bytes = byteLength(message.details);
      const deferredDetails: DeferredContentRef = { entryId, originalBytes: bytes, contentType: "details" };
      candidates.push({
        bytes,
        details: true,
        defer: () => {
          delete message.details;
          message.deferredDetails = deferredDetails;
        },
      });
    }
    if (typeof message.content === "string") {
      const original = message.content;
      const bytes = Buffer.byteLength(original, "utf8");
      const deferredContent: DeferredContentRef = { entryId, blockIndex: 0, originalBytes: bytes, contentType: "text" };
      candidates.push({
        bytes,
        details: false,
        defer: (previewBytes) => {
          message.content = [{ type: "text", text: utf8Preview(original, previewBytes), deferredContent }];
        },
      });
      return;
    }
    message.content.forEach((block, blockIndex) => {
      if (block.type === "text") {
        const original = block.text;
        const bytes = Buffer.byteLength(original, "utf8");
        const deferredContent: DeferredContentRef = {
          entryId,
          blockIndex,
          originalBytes: bytes,
          contentType: "text",
        };
        candidates.push({
          bytes,
          details: false,
          defer: (previewBytes) => {
            (message.content as TextContent[])[blockIndex] = {
              ...block,
              text: utf8Preview(original, previewBytes),
              deferredContent,
            };
          },
        });
      } else if (block.type === "thinking") {
        const original = block.thinking;
        const bytes = Buffer.byteLength(original, "utf8");
        const deferredContent: DeferredContentRef = {
          entryId,
          blockIndex,
          originalBytes: bytes,
          contentType: "thinking",
        };
        candidates.push({
          bytes,
          details: false,
          defer: (previewBytes) => {
            (message.content as ThinkingContent[])[blockIndex] = {
              ...block,
              thinking: utf8Preview(original, previewBytes),
              deferredContent,
            };
          },
        });
      } else if (block.type === "toolCall") {
        const serializedInput = JSON.stringify(block.input ?? {});
        const bytes = Buffer.byteLength(serializedInput, "utf8");
        const deferredContent: DeferredContentRef = {
          entryId,
          blockIndex,
          originalBytes: bytes,
          contentType: "toolCall",
        };
        candidates.push({
          bytes,
          details: false,
          defer: (previewBytes) => {
            (message.content as ToolCallContent[])[blockIndex] = {
              ...block,
              input: { preview: utf8Preview(serializedInput, previewBytes) },
              deferredContent,
            };
          },
        });
      } else if (block.type === "image") {
        const bytes = byteLength(block);
        const deferredContent: DeferredContentRef = {
          entryId,
          blockIndex,
          originalBytes: bytes,
          contentType: "image",
        };
        candidates.push({
          bytes,
          details: false,
          defer: () => {
            (message.content as ImageContent[])[blockIndex] = {
              type: "image",
              source: { type: "url", url: "" },
              deferredContent,
            };
          },
        });
      }
    });
  });
  return candidates.sort((a, b) => b.bytes - a.bytes);
}

function compactMessages(items: ProjectedMessage[]): CompactedMessages {
  const messages = cloneMessages(items);
  const entryIds = items.map((item) => item.entryId);
  return { messages, entryIds, candidates: collectContentCandidates(messages, entryIds) };
}

function applyDeferStage(candidates: ContentCandidate[], stage: DeferStage): void {
  for (const candidate of candidates) {
    if (candidate.bytes <= stage.thresholdBytes || (candidate.details && !stage.includeDetails)) continue;
    candidate.defer(stage.previewBytes);
  }
}

function pageBytes({ messages, entryIds }: Pick<CompactedMessages, "messages" | "entryIds">): number {
  return byteLength({ messages, entryIds });
}

function withMessages(items: ProjectedMessage[], messages: AgentMessage[]): ProjectedMessage[] {
  return items.map((item, index) => ({ ...item, message: messages[index] }));
}

interface FitTurnOptions {
  /** The page is still empty: return something even when nothing fits, so pagination always advances. */
  force: boolean;
  /** False for the remaining head of a turn that a newer page already split; it cannot be kept together. */
  complete: boolean;
}

/**
 * Fits a turn into `maxBytes`. A complete turn is preferred, using aggressive previews when needed to keep it
 * together. Otherwise the newest contiguous suffix is returned with standard previews decided for those messages
 * alone, so the entry-id cursor can continue inside the turn. If not even the newest message fits, an empty page
 * (`force`) gives it progressively smaller previews and returns it even when fixed metadata keeps it over budget, so
 * pagination always makes progress; otherwise null leaves the turn for a fresh page.
 */
function fitTurnToBudget(
  turn: ProjectedMessage[],
  maxBytes: number,
  { force, complete }: FitTurnOptions,
): ProjectedMessage[] | null {
  const whole = compactMessages(turn);
  applyDeferStage(whole.candidates, STANDARD_STAGE);
  if (pageBytes(whole) <= maxBytes) return withMessages(turn, whole.messages);
  if (complete) {
    applyDeferStage(whole.candidates, AGGRESSIVE_STAGE);
    if (pageBytes(whole) <= maxBytes) return withMessages(turn, whole.messages);
  }

  if (turn.length > 1) {
    const standard = compactMessages(turn);
    applyDeferStage(standard.candidates, STANDARD_STAGE);
    let bytes = pageBytes({ messages: [], entryIds: [] });
    let start = turn.length;
    while (start > 0) {
      const index = start - 1;
      // Both serialized arrays need a comma between successive items.
      const itemBytes =
        byteLength(standard.messages[index]) + byteLength(standard.entryIds[index]) + (start < turn.length ? 2 : 0);
      if (bytes + itemBytes > maxBytes) break;
      bytes += itemBytes;
      start = index;
    }
    if (start < turn.length) return withMessages(turn.slice(start), standard.messages.slice(start));
  }

  // Leftover space after newer turns is not worth smaller previews; the next page has the full budget.
  if (!force) return null;
  const newest = turn.slice(-1);
  const single = compactMessages(newest);
  for (const stage of [STANDARD_STAGE, AGGRESSIVE_STAGE, MINIMAL_STAGE]) {
    applyDeferStage(single.candidates, stage);
    if (pageBytes(single) <= maxBytes) break;
  }
  return withMessages(newest, single.messages);
}

export function buildSessionHistoryPage(options: {
  entries: SessionEntry[];
  leafId?: string | null;
  historyWindow?: HistoryWindow;
  historyRevision: string;
  cursor?: HistoryCursorPayload;
}): PagedContextInfo {
  const { entries, historyWindow, historyRevision, cursor } = options;
  const anchorLeafId = cursor?.anchorLeafId ?? options.leafId ?? entries.at(-1)?.id ?? null;
  const path = buildEntryPath(entries, anchorLeafId);
  const selection = path.findLast((entry) => entry.type === "model_change");
  const selectedModel =
    selection?.type === "model_change" ? { provider: selection.provider, modelId: selection.modelId } : undefined;
  if (cursor) {
    if (cursor.historyRevision !== historyRevision) throw new StaleHistoryCursorError();
    if (path.length < cursor.anchorPathLength) throw new StaleHistoryCursorError();
    if (!path.some((entry) => entry.id === cursor.anchorLeafId)) throw new StaleHistoryCursorError();
    if (!path.some((entry) => entry.id === cursor.beforeEntryId)) throw new StaleHistoryCursorError();
  }

  if (!historyWindow && !cursor) {
    const context = buildSessionContext(entries, options.leafId);
    return {
      ...context,
      selectedModel,
      totalMessages: context.messages.length,
      loadedMessages: context.messages.length,
      truncatedBefore: false,
      historyRevision,
    };
  }

  const settings = deriveContextSettings(path);
  const allMessages = projectDisplayMessages(path);
  const beforePathIndex = cursor ? path.findIndex((entry) => entry.id === cursor.beforeEntryId) : path.length;
  if (beforePathIndex < 0) throw new StaleHistoryCursorError();
  const available = allMessages.filter((item) => item.pathIndex < beforePathIndex);
  const turns = groupTurns(available);
  // A cursor that does not start at a user message leaves only the head of a split turn before it.
  const cursorMessage = allMessages.find((item) => item.pathIndex >= beforePathIndex)?.message;
  const continuesSplitTurn = cursorMessage !== undefined && cursorMessage.role !== "user";
  const maxTurns = Math.max(1, Math.floor(historyWindow?.maxTurns ?? DEFAULT_MAX_TURNS));
  const maxBytes = Math.max(32 * 1024, Math.floor(historyWindow?.maxBytes ?? DEFAULT_MAX_BYTES));
  let selected: ProjectedMessage[] = [];

  for (let index = turns.length - 1; index >= 0 && turns.length - index <= maxTurns; index -= 1) {
    const remaining =
      maxBytes -
      RESPONSE_OVERHEAD_BYTES -
      byteLength({
        messages: selected.map((item) => item.message),
        entryIds: selected.map((item) => item.entryId),
      });
    if (remaining <= 0) break;
    // An empty page must always make progress, even past the soft byte budget.
    const fitted = fitTurnToBudget(turns[index], remaining, {
      force: selected.length === 0,
      complete: !(continuesSplitTurn && index === turns.length - 1),
    });
    if (!fitted) break;
    selected = [...fitted, ...selected];
    // Earlier turns must wait until the unselected head of this turn is loaded.
    if (fitted.length < turns[index].length) break;
  }

  const firstSelected = selected[0];
  const hasOlder = Boolean(firstSelected && allMessages.some((item) => item.pathIndex < firstSelected.pathIndex));
  const previousCursor =
    hasOlder && anchorLeafId && firstSelected
      ? encodeHistoryCursor({
          version: 1,
          historyRevision,
          anchorLeafId,
          beforeEntryId: firstSelected.entryId,
          anchorPathLength: path.length,
        })
      : undefined;

  return {
    messages: selected.map((item) => item.message),
    entryIds: selected.map((item) => item.entryId),
    ...settings,
    selectedModel,
    totalMessages: allMessages.length,
    loadedMessages: selected.length,
    truncatedBefore: hasOlder,
    ...(previousCursor ? { previousCursor } : {}),
    historyRevision,
  };
}

export function readSessionEntryDetails(entries: SessionEntry[], entryId: string): { details: unknown } | null {
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  const message = entryToUiMessage(entry);
  if (!message || (message.role !== "toolResult" && message.role !== "custom")) return null;
  return message.details === undefined ? null : { details: message.details };
}

export function readSessionEntryContent(
  entries: SessionEntry[],
  entryId: string,
  blockIndex = 0,
): TextContent | ImageContent | ThinkingContent | ToolCallContent | null {
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  const message = entryToUiMessage(entry);
  if (!message) return null;
  if (typeof message.content === "string") return blockIndex === 0 ? { type: "text", text: message.content } : null;
  const block = message.content[blockIndex];
  return block?.type === "text" || block?.type === "image" || block?.type === "thinking" || block?.type === "toolCall"
    ? block
    : null;
}
