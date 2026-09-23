import {
  SessionManager,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type {
  AgentMessage,
  ChannelMessageAttachment,
  SessionEntry,
  SessionInfo,
  SessionContext,
  UserMessage,
} from "../shared/types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "../shared/normalize";
import { resolveProject, type ProjectInfo } from "../shared/worktree";
import { skillInvocationCommandText } from "../shared/skill-invocation";
import { sessionIndex } from "./session-index";
import { readSessionSnapshot } from "./session-readonly.ts";

export { getAgentDir };

export async function listAllSessions(): Promise<SessionInfo[]> {
  try {
    await sessionIndex.refreshAll();
    return await sessionIndex.getAll();
  } catch (error) {
    console.error("[agent-host] session index unavailable; falling back to pi listAll:", error);
    return listAllSessionsFallback();
  }
}

async function listAllSessionsFallback(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(
    uniqueCwds.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }),
  );

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: skillInvocationCommandText(s.firstMessage || "(no messages)"),
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

// Session path cache: sessionId → absolute file path. Its lifetime is bounded
// by the Agent Host utility process.
const sessionPathCache = new Map<string, string>();

function getPathCache(): Map<string, string> {
  return sessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (cached) getPathCache().delete(sessionId);

  const indexed = await sessionIndex.resolvePath(sessionId);
  if (indexed) getPathCache().set(sessionId, indexed);
  return indexed;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function getSessionIndexMetrics() {
  return sessionIndex.getMetrics();
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

function findCachedSessionId(filePath: string): string | undefined {
  for (const [id, cachedPath] of getPathCache()) {
    if (cachedPath === filePath) return id;
  }
  return undefined;
}

function getMessageTextContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

function getMessageActivityTime(entry: SessionEntry): number | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role?: unknown; timestamp?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (!getMessageTextContent(entry.message)) return undefined;
  if (typeof message.timestamp === "number") return message.timestamp;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Build the Desktop SessionInfo for one already-open session without scanning all session files. */
export async function buildSessionInfoFromManager(
  filePath: string,
  manager: SessionManager,
  entries: SessionEntry[],
  options: { resolveProjectInfo?: boolean } = {},
): Promise<SessionInfo | null> {
  const header = manager.getHeader();
  if (!header) return null;

  cacheSessionPath(header.id, filePath);
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityTime: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    const activityTime = getMessageActivityTime(entry);
    if (activityTime !== undefined) lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
    const message = entry.message as unknown as { role?: unknown };
    if (!firstMessage && message.role === "user") {
      firstMessage = skillInvocationCommandText(getMessageTextContent(entry.message));
    }
  }

  const headerTime = Date.parse(header.timestamp);
  const created = Number.isNaN(headerTime) ? header.timestamp : new Date(headerTime).toISOString();
  const modified = lastActivityTime === undefined ? created : new Date(lastActivityTime).toISOString();
  const project = header.cwd && options.resolveProjectInfo !== false ? await resolveProject(header.cwd) : undefined;
  const parentSessionId = header.parentSession ? findCachedSessionId(header.parentSession) : undefined;

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd,
    name: manager.getSessionName(),
    created,
    modified,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    ...(parentSessionId ? { parentSessionId } : {}),
    projectRoot: project?.projectRoot ?? header.cwd,
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = readSessionSnapshot(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Build UI history from the FULL branch path (root to leaf), without trimming.
  // pi's buildSessionContext targets LLM context: it drops everything before the last
  // compaction's firstKeptEntryId. Correct for the model, but it would hide compacted
  // history from the UI. We keep piCtx only for thinkingLevel/model, and render every
  // displayable entry on the path ourselves; compaction/branch_summary entries become
  // inline summary messages so the user still sees where context was compressed.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  let pendingChannelSource: ChannelSourceMarker | null = null;
  for (const e of path) {
    if (e.type === "custom" && e.customType === "pi-desktop-channel-source") {
      const marker = parseChannelSourceMarker(e.data);
      if (marker) pendingChannelSource = marker;
      continue;
    }
    if (e.type === "custom" && e.customType === "pi-desktop-channel-source-cancelled") {
      const runId = parseRunId(e.data);
      if (!runId || pendingChannelSource?.runId === runId) pendingChannelSource = null;
      continue;
    }

    let m = entryToUiMessage(e);
    if (m) {
      if (m.role === "user") {
        m = withUserMessageSource(m, pendingChannelSource?.channel, pendingChannelSource?.attachments);
        pendingChannelSource = null;
      }
      messages.push(m);
      entryIds.push(e.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

export function parseRunId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}

export function parseChannelSourceMarker(data: unknown): ChannelSourceMarker | null {
  if (!data || typeof data !== "object") return null;
  const marker = data as { channel?: unknown; runId?: unknown; attachments?: unknown };
  if (marker.channel !== "weixin" && marker.channel !== "telegram" && marker.channel !== "feishu") return null;
  const attachments = parseChannelAttachments(marker.attachments);
  return {
    channel: marker.channel,
    ...(typeof marker.runId === "string" ? { runId: marker.runId } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

type ChannelSourceMarker = {
  channel: NonNullable<UserMessage["channelSource"]>;
  runId?: string;
  attachments?: ChannelMessageAttachment[];
};

function parseChannelAttachments(value: unknown): ChannelMessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const attachment = candidate as { kind?: unknown; name?: unknown; mime?: unknown };
    if (
      attachment.kind !== "image" &&
      attachment.kind !== "voice" &&
      attachment.kind !== "file" &&
      attachment.kind !== "video"
    ) {
      return [];
    }
    return [
      {
        kind: attachment.kind,
        ...(typeof attachment.name === "string" && attachment.name.trim() ? { name: attachment.name } : {}),
        ...(typeof attachment.mime === "string" && attachment.mime.trim() ? { mime: attachment.mime } : {}),
      },
    ];
  });
}

export function withUserMessageSource(
  message: UserMessage,
  source?: NonNullable<UserMessage["channelSource"]>,
  attachments?: ChannelMessageAttachment[],
): UserMessage {
  const legacy = parseLegacyChannelMessage(message);
  return {
    ...legacy.message,
    ...(source || legacy.source ? { channelSource: source ?? legacy.source } : {}),
    ...(attachments?.length ? { channelAttachments: attachments } : {}),
  };
}

function parseLegacyChannelMessage(message: UserMessage): {
  message: UserMessage;
  source?: NonNullable<UserMessage["channelSource"]>;
} {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const sourceLabel = text.match(/^\[外部消息来源：(微信|Telegram|飞书 \/ Lark)\]\n/)?.[1];
  const delimiter = text.indexOf("\n---\n");
  if (!sourceLabel || delimiter < 0) return { message };

  const source = sourceLabel === "微信" ? "weixin" : sourceLabel === "Telegram" ? "telegram" : ("feishu" as const);
  const actualText = text.slice(delimiter + "\n---\n".length);
  if (typeof message.content === "string") {
    return { message: { ...message, content: actualText }, source };
  }

  let replacedText = false;
  const content = message.content.map((block) => {
    if (block.type !== "text" || replacedText) return block;
    replacedText = true;
    return { ...block, text: actualText };
  });
  return { message: { ...message, content }, source };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(entry: SessionEntry): AgentMessage | null {
  switch (entry.type) {
    case "message":
      return normalizeToolCalls(entry.message);
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      if (entry.customType === "pi-desktop-channel-attachment-context") return null;
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
