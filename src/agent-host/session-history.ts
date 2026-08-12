import { createHash } from "node:crypto";
import { statSync } from "node:fs";
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
const DEFER_THRESHOLD_BYTES = 128 * 1024;
const DEFER_PREVIEW_BYTES = 16 * 1024;
const RESPONSE_OVERHEAD_BYTES = 2048;

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
  defer: (previewBytes: number) => void;
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
    if (typeof message.content === "string") {
      const original = message.content;
      const bytes = Buffer.byteLength(original, "utf8");
      const deferredContent: DeferredContentRef = { entryId, blockIndex: 0, originalBytes: bytes, contentType: "text" };
      candidates.push({
        bytes,
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

function fitTurnToBudget(turn: ProjectedMessage[], maxBytes: number): ProjectedMessage[] | null {
  const messages = cloneMessages(turn);
  const entryIds = turn.map((item) => item.entryId);
  const candidates = collectContentCandidates(messages, entryIds);
  for (const candidate of candidates) {
    if (candidate.bytes <= DEFER_THRESHOLD_BYTES) continue;
    candidate.defer(DEFER_PREVIEW_BYTES);
  }
  if (byteLength({ messages, entryIds }) > maxBytes) {
    for (const candidate of candidates) {
      if (candidate.bytes > 4 * 1024) candidate.defer(2 * 1024);
    }
  }
  if (byteLength({ messages, entryIds }) > maxBytes) return null;
  return turn.map((item, index) => ({ ...item, message: messages[index] }));
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
    const fitted = fitTurnToBudget(turns[index], remaining);
    if (!fitted) break;
    selected = [...fitted, ...selected];
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
    totalMessages: allMessages.length,
    loadedMessages: selected.length,
    truncatedBefore: hasOlder,
    ...(previousCursor ? { previousCursor } : {}),
    historyRevision,
  };
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
