import { formatTime } from "@/lib/message-metadata";
import { memo, useState, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { ToolResultImages } from "./ToolResultImages";
import { ReplyImage } from "./ReplyImage";
import { EnlargableImage } from "./ImageLightbox";
import { DeferredContentActions } from "./DeferredContentActions";
import { AssistantOutcome } from "./AssistantOutcome";
import { Button } from "./ui/Button";
import { scaledChatFont } from "@/lib/chat-appearance";
import { getToolResultDisplayText } from "@/lib/tool-result-display";
import { toolActionTitle } from "@/lib/tool-action-title";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { createStreamRateState, estimateTokens, resetStreamRate, updateStreamRate } from "@/lib/stream-rate";
import { hasRenderableAssistantMessage, isEmptyTextBlock, isEmptyThinkingBlock } from "@/lib/message-display";
import { getUserBubbleStyle } from "@/lib/channel-message-style";
import { CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER, channelAttachmentCopyText } from "@shared/channel-message";
import { parseSkillInvocation, skillInvocationCommandText, type SkillInvocation } from "@shared/skill-invocation";
import { useI18n } from "@/i18n";
import { ArrowDown, Check, ChevronRight, Copy, CornerUpRight, GitBranch } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { ThinkingExpansionStore } from "@/lib/thinking-expansion-store";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  LoadDeferredContent,
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
  runningToolCallIds?: ReadonlySet<string>;
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
  onLoadDeferredContent?: LoadDeferredContent;
  thinkingExpansionStore?: ThinkingExpansionStore;
}

export const MessageView = memo(function MessageView({
  message,
  isStreaming,
  toolResults,
  toolCallDurations,
  runningToolCallIds,
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
  thinkingExpansionStore,
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
        runningToolCallIds={runningToolCallIds}
        modelNames={modelNames}
        cwd={cwd}
        onOpenFile={onOpenFile}
        showTimestamp={showTimestamp}
        prevTimestamp={prevTimestamp}
        onLoadDeferredContent={onLoadDeferredContent}
        entryId={entryId}
        thinkingExpansionStore={thinkingExpansionStore}
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
          <DeferredContentActions
            content={message.content}
            details={(message as CustomMessage).deferredDetails}
            onLoad={onLoadDeferredContent}
          />
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
  onLoadDeferredContent?: LoadDeferredContent;
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
  const skillInvocation = useMemo(() => parseSkillInvocation(content), [content]);

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
    : skillInvocation
      ? (skillInvocation.userMessage ?? "")
      : content;
  const skillCommand = skillInvocation ? skillInvocationCommandText(content) : null;
  const copyableContent = isChannelAttachmentPlaceholder ? attachmentCopyContent : (skillCommand ?? visibleContent);
  const editableContent = skillCommand ?? content;

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
            fontSize: scaledChatFont(13.5),
            lineHeight: 1.55,
            color: bubbleStyle.foreground,
            wordBreak: "break-word",
          }}
        >
          {skillInvocation && (
            <SkillInvocationView
              invocation={skillInvocation}
              cwd={cwd}
              onOpenFile={onOpenFile}
              followedByContent={imageBlocks.length > 0 || Boolean(visibleContent)}
            />
          )}
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: visibleContent ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                const src = imageSource(img);
                if (!src) return null;
                return (
                  <EnlargableImage
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
          <Button
            type="button"
            variant="ghost"
            onClick={copyContent}
            disabled={!copyableContent}
            title={copyableContent ? "Copy message" : "Nothing to copy"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 32,
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : undefined,
              fontSize: scaledChatFont(12),
              fontWeight: 400,
              whiteSpace: "nowrap",
            }}
          >
            {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
            {copied ? "Copied" : "Copy"}
          </Button>
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
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onNavigate!(prevAssistantEntryId!);
                  onEditContent?.(editableContent);
                }}
                title="Edit from here — branches within this session"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  height: 32,
                  border: "none",
                  borderRadius: 5,
                  fontSize: scaledChatFont(12),
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                }}
              >
                <CornerUpRight size={11} strokeWidth={1.8} />
                Edit from here
              </Button>
            )}
            {canFork && (
              <Button
                type="button"
                variant="ghost"
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
                  border: "none",
                  borderRadius: 5,
                  color: forking ? "var(--accent)" : undefined,
                  fontSize: scaledChatFont(12),
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                }}
              >
                <GitBranch size={11} strokeWidth={1.8} />
                {forking ? "Creating…" : "New session"}
              </Button>
            )}
          </div>
        )}
        {time && <span style={{ fontSize: scaledChatFont(12), color: "var(--text-dim)" }}>{time}</span>}
      </div>
    </div>
  );
}

function SkillInvocationView({
  invocation,
  cwd,
  onOpenFile,
  followedByContent,
}: {
  invocation: SkillInvocation;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  followedByContent: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggleTitle = expanded
    ? t("collapseSkillInvocation", "Hide skill instructions")
    : t("expandSkillInvocation", "Show skill instructions");

  return (
    <div
      data-testid="skill-invocation"
      data-skill-name={invocation.name}
      style={{
        overflow: "hidden",
        marginBottom: followedByContent ? 8 : 0,
        border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
        borderRadius: 7,
        background: "color-mix(in srgb, var(--bg) 88%, transparent)",
        color: "var(--text)",
      }}
    >
      <Button
        type="button"
        className="skill-invocation-toggle"
        aria-expanded={expanded}
        title={toggleTitle}
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 9px",
          borderBottom: expanded ? "1px solid var(--border)" : "none",
          background: "color-mix(in srgb, var(--bg-panel) 82%, transparent)",
          color: "var(--text-muted)",
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={1.6}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: scaledChatFont(11), fontWeight: 650 }}>
          {t("skillInvocation", "skill")}
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            color: "var(--text)",
            fontSize: scaledChatFont(12),
            fontWeight: 600,
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {invocation.name}
        </span>
      </Button>

      {expanded && (
        <div
          style={{
            maxHeight: "min(52vh, 480px)",
            overflowY: "auto",
            padding: "10px 12px 11px",
            overflowWrap: "anywhere",
          }}
        >
          <MarkdownBody className="markdown-skill-invocation" cwd={cwd} onOpenFile={onOpenFile}>
            {invocation.content}
          </MarkdownBody>
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  toolCallDurations,
  runningToolCallIds,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  onLoadDeferredContent,
  entryId,
  thinkingExpansionStore,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
  toolCallDurations?: ReadonlyMap<string, number>;
  runningToolCallIds?: ReadonlySet<string>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  onLoadDeferredContent?: LoadDeferredContent;
  entryId?: string;
  thinkingExpansionStore?: ThinkingExpansionStore;
}) {
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }) && !isEmptyTextBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const [hovered, setHovered] = useState(false);
  const { copied, copy } = useCopyFeedback();
  const [tps, setTps] = useState<number | null>(null);
  const streamRateRef = useRef(createStreamRateState());
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

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
      resetStreamRate(streamRateRef.current);
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
      // Sliding-window rate: immune to mid-stream remounts (session switch and
      // back), unlike a cumulative total divided by wall time.
      setTps(updateStreamRate(streamRateRef.current, now, estimateTokens(chars)));
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (!hasRenderableAssistantMessage(message, { isStreaming }) && !isStreaming) return null;

  return (
    <div
      style={{ marginBottom: 14, maxWidth: "var(--chat-assistant-max-width, 68ch)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: scaledChatFont(12),
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
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                        fontSize: scaledChatFont(12),
                        fontWeight: 400,
                      }}
                    >
                      <ArrowDown size={10} strokeWidth={1.2} />
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
                              fontSize: scaledChatFont(11),
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
            isStreaming={isStreaming && originalIndex === blockItems.at(-1)?.originalIndex}
            streamingDuration={
              streamingDurations.get(originalIndex) ??
              (block.type === "thinking" ? thinkingDurationFromFile : undefined)
            }
            toolCallDurations={toolCallDurations}
            runningToolCallIds={runningToolCallIds}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onLoadDeferredContent={onLoadDeferredContent}
            thinkingStateKey={`${entryId ?? "assistant"}:${originalIndex}`}
            thinkingExpansionStore={thinkingExpansionStore}
          />
        ))}
        <DeferredContentActions
          content={message.content.filter((block) => block.type !== "image")}
          onLoad={onLoadDeferredContent}
        />
        <AssistantOutcome message={message} isStreaming={isStreaming} />
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
          <div style={{ fontSize: scaledChatFont(12), color: "var(--text-dim)" }}>{formatUsage(message.usage)}</div>
        )}
        {textContent && !isStreaming && (
          <Button
            type="button"
            className="message-hover-action"
            variant="ghost"
            onClick={copyContent}
            title="Copy message"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 32,
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : undefined,
              fontSize: scaledChatFont(12),
              fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
          >
            {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: scaledChatFont(12), color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
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
  runningToolCallIds,
  cwd,
  onOpenFile,
  onLoadDeferredContent,
  thinkingStateKey,
  thinkingExpansionStore,
}: {
  block: AssistantContentBlock;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
  isStreaming?: boolean;
  streamingDuration?: number;
  toolCallDurations?: ReadonlyMap<string, number>;
  runningToolCallIds?: ReadonlySet<string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onLoadDeferredContent?: LoadDeferredContent;
  thinkingStateKey: string;
  thinkingExpansionStore?: ThinkingExpansionStore;
}) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "image") return <ReplyImage image={block} onLoad={onLoadDeferredContent} />;
  if (block.type === "thinking") {
    return (
      <>
        <ThinkingBlock
          block={block as ThinkingContent}
          duration={streamingDuration}
          stateKey={thinkingStateKey}
          store={thinkingExpansionStore}
        />
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
        <ToolCallBlock
          block={tc}
          result={result}
          duration={duration}
          running={runningToolCallIds?.has(tc.toolCallId)}
          onLoadDeferredContent={onLoadDeferredContent}
        />
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
        fontSize: scaledChatFont(13.5),
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

function ThinkingBlock({
  block,
  duration,
  stateKey,
  store,
}: {
  block: ThinkingContent;
  duration?: number;
  stateKey: string;
  store?: ThinkingExpansionStore;
}) {
  const localStoreRef = useRef<ThinkingExpansionStore | null>(null);
  if (!localStoreRef.current) localStoreRef.current = new ThinkingExpansionStore(1);
  const stateStore = store ?? localStoreRef.current;
  const getSnapshot = useMemo(() => () => stateStore.getSnapshot(stateKey), [stateKey, stateStore]);
  const expanded = useSyncExternalStore(stateStore.subscribe, getSnapshot, getSnapshot);
  const { t } = useI18n();
  const toggleExpanded = () => stateStore.toggle(stateKey);
  return (
    <div
      style={{
        border: "1px dashed var(--thinking-border)",
        borderRadius: 9,
        overflow: "hidden",
        fontSize: scaledChatFont(13),
        background: "var(--thinking-bg)",
      }}
    >
      <Button
        onClick={toggleExpanded}
        variant="ghost"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 8,
          width: "100%",
          padding: "7px 12px",
          border: "none",
          fontSize: scaledChatFont(11.5),
          fontFamily: "var(--font-mono)",
        }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
        <span>{t("thinkingLabel", "thinking")}</span>
        {duration !== undefined && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: scaledChatFont(11),
              color: "var(--text-dim)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {duration}s
          </span>
        )}
        {duration === undefined && !expanded && (
          <span style={{ marginLeft: "auto", fontSize: scaledChatFont(11), color: "var(--text-dim)" }}>
            {t("collapsed", "collapsed")}
          </span>
        )}
      </Button>
      {expanded && (
        <div
          style={{
            padding: "0 12px 10px",
            color: "var(--text-muted)",
            fontSize: scaledChatFont(12.5),
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
  running,
  onLoadDeferredContent,
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  running?: boolean;
  onLoadDeferredContent?: LoadDeferredContent;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { t } = useI18n();
  const inputStr = JSON.stringify(block.input, null, 2);
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;

  // Result display
  const resultText = getToolResultDisplayText(block.toolName, result, t);
  const resultIsEmpty = resultText === null ? false : resultText.trim() === "(no output)" || resultText.trim() === "";
  const isError = result?.isError ?? false;
  const isRunning = !result && running === true;
  const actionTitle = toolActionTitle(block.toolName, block.input, t);
  const browserTabId = isBrowserToolName(block.toolName) ? browserTabIdFromResult(resultText) : null;
  const browserSummary =
    isBrowserToolName(block.toolName) && resultText && !isError ? browserResultSummary(resultText, t) : null;
  // A collapsed card shows only its header, so the failure reason (or a browser
  // tool's compact summary) rides along as the hover hint instead of a preview.
  const collapsedHint = (() => {
    if (expanded) return null;
    if (isError) return resultText?.split("\n")[0]?.trim() || null;
    return browserSummary;
  })();

  return (
    <div
      className="pi-tool-card"
      style={{
        borderRadius: 9,
        overflow: "hidden",
        fontSize: scaledChatFont(12),
        fontFamily: "var(--font-mono)",
        background: "var(--tool-bg)",
        border: isError
          ? "1px solid color-mix(in srgb, var(--danger) 55%, transparent)"
          : "1px solid var(--tool-border)",
      }}
    >
      {/* ── Tool call header ── */}
      <Button
        onClick={() => setExpanded((v) => !v)}
        variant="ghost"
        className="tool-action-toggle"
        aria-expanded={expanded}
        data-error={isError || undefined}
        title={collapsedHint ?? actionTitle}
        style={{ display: "flex", gap: 8, padding: "8px 12px", fontSize: scaledChatFont(12) }}
      >
        <span className="tool-action-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="tool-action-title">{actionTitle}</span>
        <span className="tool-action-name">{block.toolName}</span>
        {isRunning && <span className="tool-action-status">{t("toolActionRunning", "Running…")}</span>}
        {isError && <span className="tool-action-status">{t("toolActionExecutionFailed", "Failed")}</span>}
        {duration !== undefined && <span className="tool-action-duration">{duration}s</span>}
      </Button>

      {/* ── Expanded: input args ── */}
      {expanded && !isEditTool && (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            color: "var(--tool-fg)",
            fontSize: scaledChatFont(12),
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

      {!result && running === false && (
        <p style={{ padding: "8px 12px", color: "var(--text-dim)", margin: 0 }}>
          {t("executionResultMissing", "Result was not recorded in the conversation.")}
        </p>
      )}

      {/* ── Paired result — only while expanded ──
          A collapsed card keeps just its header, so long outputs never form a
          wall; the hover hint on the header carries the failure reason. */}
      {expanded &&
        result &&
        (resultDiff ? (
          <PairedDiffResult diff={resultDiff} />
        ) : (
          <PairedResult text={resultText ?? ""} isEmpty={resultIsEmpty} isError={isError} />
        ))}
      {expanded && result && <ToolResultImages content={result.content} />}
      {expanded && result && result.details !== undefined && !resultDiff && (
        <div style={{ borderTop: "1px solid var(--tool-border)" }}>
          <Button
            variant="link"
            aria-expanded={detailsExpanded}
            onClick={() => setDetailsExpanded((value) => !value)}
            style={{
              width: "100%",
              justifyContent: "flex-start",
              padding: "6px 12px",
              color: "var(--tool-fg)",
              fontSize: scaledChatFont(11),
              textAlign: "left",
            }}
          >
            {detailsExpanded ? t("toolResultDetailsHide", "Hide details") : t("toolResultDetailsShow", "Show details")}
          </Button>
          {detailsExpanded && (
            <pre
              aria-label={t("toolResultDetails", "Tool result details")}
              tabIndex={0}
              style={{
                margin: 0,
                padding: "8px 12px",
                color: "var(--tool-fg)",
                fontSize: scaledChatFont(12),
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 360,
                overflow: "auto",
              }}
            >
              {safeJson(result.details)}
            </pre>
          )}
        </div>
      )}
      {expanded && result && (
        <DeferredContentActions
          content={result.content}
          details={result.deferredDetails}
          onLoad={
            onLoadDeferredContent
              ? async (entryId, blockIndex, part) => {
                  await onLoadDeferredContent(entryId, blockIndex, part);
                  if (part === "details") setDetailsExpanded(true);
                }
              : undefined
          }
        />
      )}
      {expanded && browserTabId && (
        <Button
          type="button"
          variant="link"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("pi-desktop:open-browser-tab", { detail: { tabId: browserTabId } }))
          }
          style={{
            width: "100%",
            minHeight: 30,
            borderTop: "1px solid var(--tool-border)",
            fontSize: scaledChatFont(11),
            textAlign: "left",
            padding: "0 12px",
          }}
        >
          Open in Browser →
        </Button>
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
            fontSize: scaledChatFont(12),
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
        fontSize: scaledChatFont(12),
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

function PairedResult({ text, isEmpty, isError }: { text: string; isEmpty: boolean; isError: boolean }) {
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
          fontSize: scaledChatFont(12),
          lineHeight: 1.5,
          maxHeight: 400,
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
        <Button
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
          <ChevronRight
            size={12}
            strokeWidth={1.6}
            aria-hidden="true"
            style={{
              flexShrink: 0,
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.15s",
            }}
          />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: scaledChatFont(11), fontWeight: 650 }}>
            compaction
          </span>
          <span style={{ color: "var(--text)", fontSize: scaledChatFont(12), fontWeight: 600 }}>
            Conversation compacted
          </span>
          {time && (
            <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: scaledChatFont(10) }}>{time}</span>
          )}
        </Button>

        {expanded && (
          <div style={{ padding: "11px 13px 12px" }}>
            <div style={{ marginBottom: 10, color: "var(--text)", fontSize: scaledChatFont(14), lineHeight: 1.5 }}>
              The conversation history before this point was compacted into the following summary:
            </div>
            {parsedSummary.body ? (
              <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
            ) : (
              <span style={{ color: "var(--text-dim)", fontSize: scaledChatFont(12) }}>(no summary)</span>
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
  onLoadDeferredContent?: LoadDeferredContent;
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
            fontSize: scaledChatFont(12),
          }}
        >
          <span
            style={{
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: scaledChatFont(11),
              fontWeight: 650,
            }}
          >
            {title}
          </span>
          {isHiddenDisplay && (
            <span style={{ color: "var(--text-dim)", fontSize: scaledChatFont(11) }}>hidden extension message</span>
          )}
          {time && (
            <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: scaledChatFont(10) }}>{time}</span>
          )}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <EnlargableImage
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
              <span style={{ color: "var(--text-dim)", fontSize: scaledChatFont(12) }}>(no message)</span>
            )}
            <DeferredContentActions
              content={message.content}
              details={message.deferredDetails}
              onLoad={onLoadDeferredContent}
            />
          </div>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              fontSize: scaledChatFont(12),
              textAlign: "left",
            }}
          >
            {text ? previewText(text) : "Show extension message"}
          </Button>
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
            <Button
              variant="ghost"
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                color: copied ? "var(--accent)" : undefined,
                fontSize: scaledChatFont(11),
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <Button
              variant="ghost"
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                fontSize: scaledChatFont(11),
              }}
            >
              {isHiddenDisplay
                ? contentExpanded
                  ? "Collapse"
                  : "Expand"
                : detailsExpanded
                  ? "Hide details"
                  : "Show details"}
            </Button>
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
              fontSize: scaledChatFont(12),
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
