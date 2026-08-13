import { memo, useState, useRef, useEffect, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import {
  getAssistantFailureDetail,
  hasRenderableAssistantMessage,
  isAssistantFailure,
  isEmptyThinkingBlock,
} from "@/lib/message-display";
import { getUserBubbleStyle } from "@/lib/channel-message-style";
import { CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER, channelAttachmentCopyText } from "@shared/channel-message";
import { useI18n } from "@/i18n";
import { useTheme } from "@/hooks/useTheme";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
  toolCallDurations?: ReadonlyMap<string, number>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  return `${date} ${time}`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function DeferredContentActions({
  content,
  onLoad,
}: {
  content: unknown;
  onLoad?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  if (!onLoad || !Array.isArray(content)) return null;
  const references = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const deferred = (block as AssistantContentBlock | TextContent | ImageContent).deferredContent;
    return deferred ? [deferred] : [];
  });
  if (references.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {references.map((reference) => {
        const key = `${reference.entryId}:${reference.blockIndex ?? 0}`;
        const loading = loadingKey === key;
        return (
          <button
            key={key}
            type="button"
            disabled={loading}
            onClick={() => {
              setLoadingKey(key);
              setLoadError(false);
              void onLoad(reference.entryId, reference.blockIndex)
                .catch(() => setLoadError(true))
                .finally(() => setLoadingKey(null));
            }}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "var(--accent)",
              cursor: loading ? "default" : "pointer",
              fontSize: 11,
              padding: "4px 8px",
            }}
          >
            {loading ? "Loading full content…" : `Load full content (${formatByteSize(reference.originalBytes)})`}
          </button>
        );
      })}
      {loadError && <span style={{ color: "var(--danger)", fontSize: 11 }}>Failed to load full content</span>}
    </div>
  );
}

export const MessageView = memo(function MessageView({
  message,
  isStreaming,
  toolResults,
  toolCallDurations,
  modelNames,
  cwd,
  onOpenFile,
  entryId,
  onFork,
  forking,
  onNavigate,
  prevAssistantEntryId,
  onEditContent,
  showTimestamp,
  prevTimestamp,
  onLoadDeferredContent,
}: Props) {
  if (message.role === "user") {
    return (
      <UserMessageView
        message={message as UserMessage}
        cwd={cwd}
        onOpenFile={onOpenFile}
        entryId={entryId}
        onFork={onFork}
        forking={forking}
        onNavigate={onNavigate}
        prevAssistantEntryId={prevAssistantEntryId}
        onEditContent={onEditContent}
        onLoadDeferredContent={onLoadDeferredContent}
      />
    );
  }
  if (message.role === "assistant") {
    return (
      <AssistantMessageView
        message={message as AssistantMessage}
        isStreaming={isStreaming}
        toolResults={toolResults}
        toolCallDurations={toolCallDurations}
        modelNames={modelNames}
        cwd={cwd}
        onOpenFile={onOpenFile}
        showTimestamp={showTimestamp}
        prevTimestamp={prevTimestamp}
        onLoadDeferredContent={onLoadDeferredContent}
      />
    );
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return (
        <>
          <CompactionMessageView message={message as CustomMessage} />
          <DeferredContentActions content={message.content} onLoad={onLoadDeferredContent} />
        </>
      );
    }
    return (
      <CustomMessageView
        message={message as CustomMessage}
        cwd={cwd}
        onOpenFile={onOpenFile}
        onLoadDeferredContent={onLoadDeferredContent}
      />
    );
  }
  return null;
});

function UserMessageView({
  message,
  cwd,
  onOpenFile,
  entryId,
  onFork,
  forking,
  onNavigate,
  prevAssistantEntryId,
  onEditContent,
  onLoadDeferredContent,
}: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [hovered, setHovered] = useState(false);
  const { copied, copy } = useCopyFeedback();

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image" && !b.deferredContent);

  const isChannelAttachmentPlaceholder = !!message.channelSource && content === CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER;
  const attachmentCopyContent = isChannelAttachmentPlaceholder
    ? channelAttachmentCopyText(message.channelAttachments, imageBlocks)
    : "";
  const visibleContent = isChannelAttachmentPlaceholder
    ? imageBlocks.length > 0
      ? ""
      : attachmentCopyContent || t("channelAttachment", "Attachment")
    : content;
  const copyableContent = isChannelAttachmentPlaceholder ? attachmentCopyContent : visibleContent;

  const time = formatTime(message.timestamp);
  const messageSource = message.channelSource ?? "local";
  const bubbleStyle = getUserBubbleStyle(message.channelSource, isDark);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => void copy(copyableContent);

  return (
    <div
      style={{ marginBottom: 14, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 6,
          maxWidth: "68ch",
          width: "100%",
          justifyContent: "flex-end",
        }}
      >
        <div
          data-message-source={messageSource}
          style={{
            minWidth: 0,
            maxWidth: "100%",
            background: bubbleStyle.background,
            borderRadius: "10px 10px 2px 10px",
            padding: "9px 13px",
            fontSize: 13.5,
            lineHeight: 1.55,
            color: bubbleStyle.foreground,
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: visibleContent ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : (img.source.url ?? "")
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{
                      maxWidth: 240,
                      maxHeight: 240,
                      borderRadius: 6,
                      objectFit: "contain",
                      display: "block",
                      border: "1px solid color-mix(in srgb, var(--user-fg) 18%, transparent)",
                    }}
                  />
                );
              })}
            </div>
          )}
          {visibleContent && (
            <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>
              {visibleContent}
            </MarkdownBody>
          )}
          <DeferredContentActions content={message.content} onLoad={onLoadDeferredContent} />
        </div>
      </div>

      {/* Bottom row: action buttons + timestamp */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          marginTop: 3,
        }}
      >
        <div
          className="message-hover-actions"
          style={{
            display: "flex",
            gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}
        >
          <button
            type="button"
            onClick={copyContent}
            disabled={!copyableContent}
            title={copyableContent ? "Copy message" : "Nothing to copy"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 32,
              background: "none",
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: copyableContent ? "pointer" : "not-allowed",
              opacity: copyableContent ? 1 : 0.55,
              fontSize: 12,
              fontWeight: 400,
              whiteSpace: "nowrap",
              transition: "color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--text-dim)";
            }}
          >
            {copied ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {(canFork || canNavigate) && (
          <div
            className="message-hover-actions"
            style={{
              display: "flex",
              gap: 3,
              opacity: hovered || forking ? 1 : 0,
              pointerEvents: hovered || forking ? "auto" : "none",
              transition: "opacity 0.12s",
            }}
          >
            {canNavigate && (
              <button
                type="button"
                onClick={() => {
                  onNavigate!(prevAssistantEntryId!);
                  onEditContent?.(content);
                }}
                title="Edit from here — branches within this session"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  height: 32,
                  background: "none",
                  border: "none",
                  borderRadius: 5,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                  transition: "color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 10 20 15 15 20" />
                  <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                </svg>
                Edit from here
              </button>
            )}
            {canFork && (
              <button
                type="button"
                onClick={() => {
                  onFork!(entryId!);
                }}
                disabled={forking}
                title={forking ? "Creating new session…" : "New session — creates an independent copy from here"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  height: 32,
                  background: "none",
                  border: "none",
                  borderRadius: 5,
                  color: forking ? "var(--accent)" : "var(--text-dim)",
                  cursor: forking ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                  transition: "color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (!forking) e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  if (!forking) e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {forking ? "Creating…" : "New session"}
              </button>
            )}
          </div>
        )}
        {time && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{time}</span>}
      </div>
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  toolCallDurations,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  onLoadDeferredContent,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
  toolCallDurations?: ReadonlyMap<string, number>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const [hovered, setHovered] = useState(false);
  const { copied, copy } = useCopyFeedback();
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const failureDetail = isAssistantFailure(message)
    ? (getAssistantFailureDetail(message) ??
      t(
        "modelRequestFailedFallback",
        "The model service did not return error details. Check the API key, service URL, and model configuration.",
      ))
    : null;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => void copy(textContent);

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const bs = items.map(({ block }) => block);
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (!hasRenderableAssistantMessage(message, { isStreaming }) && !isStreaming) return null;

  return (
    <div
      style={{ marginBottom: 14, maxWidth: "68ch" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 12,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--font-mono)",
        }}
      >
        {message.provider && (
          <span>
            {modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}
          </span>
        )}
        {isStreaming &&
          (() => {
            let chars = 0;
            for (const b of blocks) {
              if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
              else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
              else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
            }
            const est = Math.round(chars / 4);
            return (
              <>
                {est > 0 && (
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }}
                    title="Estimated token count while streaming"
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 12, fontWeight: 400 }}>
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="5" y1="1.5" x2="5" y2="8.5" />
                        <polyline points="2 6 5 8.5 8 6" />
                      </svg>
                      {est}
                    </span>
                    {tps !== null &&
                      (() => {
                        const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                        return (
                          <span
                            style={{
                              marginLeft: 6,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: bg,
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 400,
                            }}
                          >
                            {tps.toFixed(1)} t/s
                          </span>
                        );
                      })()}
                  </span>
                )}
              </>
            );
          })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView
            key={originalIndex}
            block={block}
            toolResults={toolResults}
            isStreaming={isStreaming}
            streamingDuration={
              streamingDurations.get(originalIndex) ??
              (block.type === "thinking" ? thinkingDurationFromFile : undefined)
            }
            toolCallDurations={toolCallDurations}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onLoadDeferredContent={onLoadDeferredContent}
          />
        ))}
        <DeferredContentActions content={message.content} onLoad={onLoadDeferredContent} />
        {failureDetail && !isStreaming && (
          <div
            role="alert"
            data-testid="assistant-error-message"
            style={{
              border: "1px solid color-mix(in srgb, var(--danger) 45%, var(--border))",
              borderRadius: 9,
              background: "color-mix(in srgb, var(--danger) 8%, var(--assistant-bg))",
              color: "var(--danger)",
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: 1.55,
              overflowWrap: "anywhere",
              whiteSpace: "pre-wrap",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{t("modelRequestFailed", "Model request failed")}</div>
            <div>{failureDetail}</div>
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 4,
        }}
      >
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{formatUsage(message.usage)}</div>
        )}
        {textContent && !isStreaming && (
          <button
            type="button"
            className="message-hover-action"
            onClick={copyContent}
            title="Copy message"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 32,
              background: "none",
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--text-dim)";
            }}
          >
            {copied ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({
  block,
  toolResults,
  isStreaming,
  streamingDuration,
  toolCallDurations,
  cwd,
  onOpenFile,
  onLoadDeferredContent,
}: {
  block: AssistantContentBlock;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
  isStreaming?: boolean;
  streamingDuration?: number;
  toolCallDurations?: ReadonlyMap<string, number>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return (
      <>
        <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} />
        <DeferredContentActions content={[block]} onLoad={onLoadDeferredContent} />
      </>
    );
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return (
      <>
        <ToolCallBlock block={tc} result={result} duration={duration} onLoadDeferredContent={onLoadDeferredContent} />
        <DeferredContentActions content={[block]} onLoad={onLoadDeferredContent} />
      </>
    );
  }
  return null;
}

function TextBlock({
  block,
  isStreaming,
  cwd,
  onOpenFile,
}: {
  block: TextContent;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  return (
    <div
      style={{
        background: "var(--assistant-bg)",
        border: "1px solid var(--border)",
        padding: "10px 14px",
        borderRadius: "2px 10px 10px 10px",
        fontSize: 13.5,
        lineHeight: 1.6,
      }}
    >
      <MarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>
        {block.text}
      </MarkdownBody>
      {isStreaming && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
}

function ThinkingBlock({ block, duration }: { block: ThinkingContent; duration?: number }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  return (
    <div
      style={{
        border: "1px dashed var(--thinking-border)",
        borderRadius: 9,
        overflow: "hidden",
        fontSize: 13,
        background: "var(--thinking-bg)",
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 12px",
          background: "none",
          border: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
        <span>{t("thinkingLabel", "thinking")}</span>
        {duration !== undefined && (
          <span
            style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
          >
            {duration}s
          </span>
        )}
        {duration === undefined && !expanded && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
            {t("collapsed", "collapsed")}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "0 12px 10px",
            color: "var(--text-muted)",
            fontSize: 12.5,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            fontStyle: "italic",
          }}
        >
          {block.thinking}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({
  block,
  result,
  duration,
  onLoadDeferredContent,
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const inputStr = JSON.stringify(block.input, null, 2);
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;

  // Result display
  const resultText = result
    ? result.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : resultText.trim() === "(no output)" || resultText.trim() === "";
  const isError = result?.isError ?? false;
  const isRunning = !result;
  const preview = getToolPreview(block);
  const browserTabId = isBrowserToolName(block.toolName) ? browserTabIdFromResult(resultText) : null;
  const browserSummary =
    isBrowserToolName(block.toolName) && resultText && !isError ? browserResultSummary(resultText, t) : null;

  return (
    <div
      style={{
        borderRadius: 9,
        overflow: "hidden",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        background: "var(--tool-bg)",
        border: isError
          ? "1px solid color-mix(in srgb, var(--danger) 55%, transparent)"
          : "1px solid var(--tool-border)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 12px",
          background: "none",
          border: "none",
          borderBottom: expanded || result ? "1px solid var(--tool-border)" : "none",
          color: isError ? "var(--danger)" : "var(--accent)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ flexShrink: 0, opacity: 0.85 }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ fontWeight: 600, flexShrink: 0 }}>{block.toolName}</span>
        <span
          style={{
            color: "var(--tool-fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
            opacity: 0.85,
          }}
        >
          {preview}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {duration}s
          </span>
        )}
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && !isEditTool && (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            color: "var(--tool-fg)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "transparent",
            borderTop: "none",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Running indicator (design.html terminal style) ── */}
      {isRunning && !expanded && (
        <div style={{ padding: "8px 12px", color: "var(--text-dim)" }}>
          running
          <span className="stream-caret" aria-hidden="true" />
        </div>
      )}

      {/* ── Paired result — always show summary; expand for full detail ── */}
      {result &&
        (resultDiff ? (
          expanded ? (
            <PairedDiffResult diff={resultDiff} />
          ) : (
            <div
              style={{
                padding: "8px 12px",
                color: "var(--tool-fg)",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "hidden",
                opacity: 0.9,
              }}
            >
              {resultDiff.text.split("\n").slice(0, 4).join("\n")}
              {resultDiff.text.split("\n").length > 4 ? "\n…" : ""}
            </div>
          )
        ) : (
          <PairedResult
            text={!expanded && browserSummary ? browserSummary : (resultText ?? "")}
            isEmpty={resultIsEmpty}
            isError={isError}
            collapsed={!expanded}
          />
        ))}
      {result && <DeferredContentActions content={result.content} onLoad={onLoadDeferredContent} />}
      {browserTabId && (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("pi-desktop:open-browser-tab", { detail: { tabId: browserTabId } }))
          }
          style={{
            width: "100%",
            minHeight: 30,
            border: "none",
            borderTop: "1px solid var(--tool-border)",
            background: "transparent",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 11,
            textAlign: "left",
            padding: "0 12px",
          }}
        >
          Open in Browser →
        </button>
      )}
    </div>
  );
}

function isBrowserToolName(value: string): boolean {
  return value.startsWith("browser_");
}

function browserTabIdFromResult(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { tabId?: unknown; id?: unknown };
    const tabId = typeof parsed.tabId === "string" ? parsed.tabId : typeof parsed.id === "string" ? parsed.id : null;
    return tabId && tabId.length <= 128 ? tabId : null;
  } catch {
    return null;
  }
}

function browserResultSummary(value: string, t: (key: string, fallback: string) => string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.inspectionId === "string" && typeof parsed.changed === "boolean") {
      const truncated = isRecord(parsed.truncated)
        ? Object.entries(parsed.truncated)
            .filter(([, entry]) => entry === true)
            .map(([key]) => key)
            .join(", ")
        : "";
      return parsed.changed
        ? formatBrowserSummary(t("browserToolInspectChanged", "Page changed · generation {generation}{truncated}"), {
            generation: Number(parsed.generation ?? 0),
            truncated: truncated ? ` · truncated: ${truncated}` : "",
          })
        : formatBrowserSummary(t("browserToolInspectUnchanged", "Page unchanged · generation {generation}"), {
            generation: Number(parsed.generation ?? 0),
          });
    }
    if (typeof parsed.differenceRatio === "number") {
      return formatBrowserSummary(t("browserToolVisualDifference", "Visual difference: {percent}% · {pixels} pixels"), {
        percent: (parsed.differenceRatio * 100).toFixed(3),
        pixels: Number(parsed.differentPixels ?? 0).toLocaleString(),
      });
    }
    if (typeof parsed.total === "number" && typeof parsed.failed === "number" && isRecord(parsed.byResourceType)) {
      return formatBrowserSummary(
        t("browserToolNetworkSummary", "Network: {total} requests · {failed} failed · {pending} pending"),
        {
          total: parsed.total,
          failed: parsed.failed,
          pending: Number(parsed.pending ?? 0),
        },
      );
    }
    if (Array.isArray(parsed.entries)) {
      return formatBrowserSummary(t("browserToolConsoleSummary", "Console: {count} entries{truncated}"), {
        count: parsed.entries.length,
        truncated: parsed.truncated === true ? " · more available" : "",
      });
    }
  } catch {
    return null;
  }
  return null;
}

function formatBrowserSummary(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: { diff: ResultDiff }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--tool-border)",
        background: "color-mix(in srgb, var(--tool-bg) 92%, #fff)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <SplitDiffHeader title={file.oldPath || "Before"} side="left" />
              <SplitDiffHeader title={file.newPath || "After"} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
        ? "rgba(248,113,113,0.13)"
        : cell.type === "empty"
          ? "var(--bg-subtle)"
          : "transparent";
  const marker = cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--success)" : cell.type === "removed" ? "var(--danger)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div
      style={{
        maxHeight: 520,
        overflowY: "auto",
        overflowX: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.55,
        minWidth: 0,
      }}
    >
      {lines.map((line, i) => {
        const kind = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+") && !line.startsWith("+++")
            ? "added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "removed"
              : "context";
        const bg =
          kind === "added"
            ? "rgba(34,197,94,0.12)"
            : kind === "removed"
              ? "rgba(248,113,113,0.13)"
              : kind === "hunk"
                ? "rgba(96,165,250,0.12)"
                : "transparent";
        const color =
          kind === "added"
            ? "var(--success)"
            : kind === "removed"
              ? "var(--danger)"
              : kind === "hunk"
                ? "var(--accent)"
                : "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft:
                kind === "added"
                  ? "3px solid var(--success)"
                  : kind === "removed"
                    ? "3px solid var(--danger)"
                    : kind === "hunk"
                      ? "3px solid var(--accent)"
                      : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({
  text,
  isEmpty,
  isError,
  collapsed,
}: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
  collapsed?: boolean;
}) {
  return (
    <div
      style={{
        borderTop: isError
          ? "1px solid color-mix(in srgb, var(--danger) 40%, transparent)"
          : "1px solid var(--tool-border)",
        background: isError ? "color-mix(in srgb, var(--danger) 8%, transparent)" : "transparent",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 12px",
          color: isError ? "var(--danger)" : isEmpty ? "var(--text-dim)" : "var(--tool-fg)",
          fontSize: 12,
          lineHeight: 1.5,
          maxHeight: collapsed ? 180 : 400,
          overflow: "auto",
          background: "transparent",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? "(no output)" : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const [expanded, setExpanded] = useState(false);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <button
          type="button"
          className="compaction-summary-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? "Collapse compaction summary" : "Expand compaction summary"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: expanded ? "1px solid var(--border)" : "none",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{
              flexShrink: 0,
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.15s",
            }}
          >
            <polyline points="4 2.5 7.5 6 4 9.5" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>compaction</span>
          <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>Conversation compacted</span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </button>

        {expanded && (
          <div style={{ padding: "11px 13px 12px" }}>
            <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>
              The conversation history before this point was compacted into the following summary:
            </div>
            {parsedSummary.body ? (
              <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
            ) : (
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>(no summary)</span>
            )}
            <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
          </div>
        )}
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
      <summary>File context: {parts.join(", ")}</summary>
      {modifiedFiles.length > 0 && <CompactionFileList title="Modified files" files={modifiedFiles} />}
      {readFiles.length > 0 && <CompactionFileList title="Read files" files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({
  message,
  cwd,
  onOpenFile,
  onLoadDeferredContent,
}: {
  message: CustomMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onLoadDeferredContent?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { copied, copy } = useCopyFeedback();
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => void copy(text || detailsText);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>hidden extension message</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{
                        maxWidth: 240,
                        maxHeight: 240,
                        borderRadius: 6,
                        objectFit: "contain",
                        display: "block",
                        border: "1px solid var(--border)",
                      }}
                    />
                  );
                })}
              </div>
            )}
            {text ? (
              <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
                {text}
              </MarkdownBody>
            ) : (
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>(no message)</span>
            )}
            <DeferredContentActions content={message.content} onLoad={onLoadDeferredContent} />
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {text ? previewText(text) : "Show extension message"}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                ? contentExpanded
                  ? "Collapse"
                  : "Expand"
                : detailsExpanded
                  ? "Hide details"
                  : "Show details"}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image" && !b.deferredContent);
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : (img.source.url ?? "");
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
