import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ExtensionUiRequest,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { scaledChatFont } from "@/lib/chat-appearance";
import {
  countToolCallBlocks,
  getDisplayableAssistantBlocks,
  isAssistantFailure,
  splitFinalAssistantBlocks,
} from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { SessionProfiler } from "./SessionProfiler";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs, type ChatMinimapMessage } from "./ChatMinimap";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useObservedElementHeight } from "@/hooks/useObservedElementHeight";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { MessageRenderKeyRegistry, type MessageRenderRole } from "@/lib/message-render-key";
import { buildToolMessageIndex } from "@/lib/tool-message-index";
import { useI18n } from "@/i18n";
import type { ThinkingExpansionStore } from "@/lib/thinking-expansion-store";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (
    tree: SessionTreeNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (
    usage: { percent: number | null; contextWindow: number; tokens: number | null } | null,
  ) => void;
  onOpenFile?: (filePath: string) => void;
  thinkingExpansionStore: ThinkingExpansionStore;
  processDetailsExpansionStore: ThinkingExpansionStore;
}

function phaseLabel(phase: AgentPhase, t: (key: string, fallback: string) => string): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    const running = t("runningTools", "Running");
    if (names.length === 0) return t("runningTool", "Running tool…");
    if (names.length === 1) return `${running} ${names[0]}…`;
    if (names.length <= 3) return `${running} ${names.join(", ")}…`;
    return `${running} ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase?.kind === "waiting_model") return t("waitingForModel", "Waiting for model…");
  if (phase?.kind === "running_command") return t("runningCommand", "Running command…");
  return t("thinking", "Thinking…");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

function toMinimapMessage(message: AgentMessage | Partial<AgentMessage>): ChatMinimapMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = message.content;
  if (message.role === "user") {
    const preview =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ")
          : "";
    return { role: "user", preview: preview.slice(0, 200), hasText: true };
  }
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
  const toolNames = blocks.flatMap((block) => (block.type === "toolCall" ? [block.toolName] : []));
  return {
    role: "assistant",
    preview: (text || toolNames.join(", ")).slice(0, 200),
    hasText: text.length > 0,
  };
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  if (isAssistantFailure(message as AssistantMessage)) return true;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some(
    (block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
  );
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean; omitFailure?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  if (options.omitFailure) {
    next.stopReason = undefined;
    next.errorMessage = undefined;
  }
  return next;
}

type AssistantRenderParts = {
  processBlocks: AssistantContentBlock[];
  processMessage: AssistantMessage | null;
  answerMessage: AssistantMessage | null;
};

function getAssistantRenderParts(
  cache: WeakMap<AssistantMessage, AssistantRenderParts>,
  message: AssistantMessage,
): AssistantRenderParts {
  const existing = cache.get(message);
  if (existing) return existing;
  const split = splitFinalAssistantBlocks(message);
  const created: AssistantRenderParts = {
    processBlocks: split.processBlocks,
    processMessage:
      split.processBlocks.length > 0
        ? withAssistantBlocks(message, split.processBlocks, { omitUsage: true, omitFailure: true })
        : null,
    answerMessage:
      split.answerBlocks.length > 0
        ? withAssistantBlocks(message, split.answerBlocks)
        : isAssistantFailure(message)
          ? withAssistantBlocks(message, [])
          : null,
  };
  cache.set(message, created);
  return created;
}

export function ChatWindow({
  session,
  newSessionCwd,
  onAgentEnd,
  onSessionCreated,
  onSessionForked,
  modelsRefreshKey,
  chatInputRef,
  onBranchDataChange,
  onSystemPromptChange,
  onSessionStatsChange,
  onSessionStatsPanelOpen,
  onContextUsageChange,
  onOpenFile,
  thinkingExpansionStore,
  processDetailsExpansionStore,
}: Props) {
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const messageRenderKeys = useRef(new MessageRenderKeyRegistry()).current;
  const assistantRenderParts = useRef(new WeakMap<AssistantMessage, AssistantRenderParts>()).current;

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  const {
    loading,
    error,
    messages,
    entryIds,
    streamState,
    agentRunning,
    modelNames,
    modelList,
    modelCatalog,
    modelRefreshing,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    toolPreset,
    thinkingLevel,
    retryInfo,
    contextUsage,
    forkingEntryId,
    isCompacting,
    compactError,
    compactResult,
    displayModel: displayModelValue,
    sessionStats,
    slashCommands,
    slashCommandsLoading,
    queuedMessages,
    hasOlder,
    loadingOlder,
    notices,
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    respondToExtensionUi,
    sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    messagesEndRef,
    liveContentEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend,
    handleAbort,
    handleFork,
    handleNavigate,
    handleModelChange,
    refreshModels,
    cancelModelRefresh,
    handleCompact,
    handleSteer,
    handleFollowUp,
    handlePromptWithStreamingBehavior,
    handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange,
    handleThinkingLevelChange,
    loadSlashCommands,
    loadOlder,
    loadDeferredContent,
    isAwayFromBottom,
    reattachAutoFollow,
  } = useAgentSession({
    session,
    newSessionCwd,
    onAgentEnd: wrappedOnAgentEnd,
    onSessionCreated,
    onSessionForked,
    modelsRefreshKey,
    chatInputRef,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionStatsPanelOpen,
  });

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
        sessionStats.sessionId,
        sessionStats.sessionFile ?? "",
        sessionStats.sessionName ?? "",
        sessionStats.userMessages,
        sessionStats.assistantMessages,
        sessionStats.toolCalls,
        sessionStats.toolResults,
        sessionStats.totalMessages,
        sessionStats.tokens.input,
        sessionStats.tokens.output,
        sessionStats.tokens.cacheRead,
        sessionStats.tokens.cacheWrite,
        sessionStats.tokens.total,
        sessionStats.cost ?? 0,
      ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(
    () => () => {
      onSessionStatsChange?.(null);
    },
    [onSessionStatsChange],
  );

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(
    () => () => {
      onContextUsageChange?.(null);
    },
    [onContextUsageChange],
  );

  const onDrop = useCallback(
    (files: File[]) => {
      // Attaching while the agent runs is fine — send stays gated separately.
      chatInputRef?.current?.addFiles(files);
    },
    [chatInputRef],
  );

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);
  const minimapMessages = useMemo(() => messages.flatMap((message) => toMinimapMessage(message) ?? []), [messages]);
  const minimapStreamingMessage = useMemo(
    () => (streamState.streamingMessage ? toMinimapMessage(streamState.streamingMessage) : null),
    [streamState.streamingMessage],
  );
  const toolMessageIndex = useMemo(() => buildToolMessageIndex(messages), [messages]);
  const insertEditedContent = useCallback(
    (content: string) => chatInputRef?.current?.insertIfEmpty(content),
    [chatInputRef],
  );
  const olderHistorySentinelRef = useRef<HTMLDivElement | null>(null);
  const automaticHistoryPagesRef = useRef(0);

  useEffect(() => {
    automaticHistoryPagesRef.current = 0;
  }, [session?.id]);

  useEffect(() => {
    const sentinel = olderHistorySentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || !hasOlder || loadingOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || automaticHistoryPagesRef.current >= 3) return;
        automaticHistoryPagesRef.current += 1;
        void loadOlder();
      },
      { root, rootMargin: "160px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder, loadingOlder, messages.length, scrollContainerRef]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const chatViewportHeight = useObservedElementHeight(scrollContainerRef);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelCatalog={modelCatalog}
      modelRefreshing={modelRefreshing}
      onModelChange={handleModelChange}
      onModelsRefresh={refreshModels}
      onModelsRefreshCancel={cancelModelRefresh}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return <div className="flex h-full items-center justify-center text-text-muted">Loading session...</div>;
  }

  if (error) {
    return <div className="flex h-full items-center justify-center text-red-400">{error}</div>;
  }

  return (
    <div
      className="chat-appearance-scope relative flex h-full flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Grid paper + corner ticks (design.html grid style) */}
      <div
        className={`chat-grid-bg${isEmptyNew ? " chat-grid-bg-idle" : ""} pointer-events-none absolute inset-0 z-0`}
        aria-hidden="true"
      />
      <div className="chat-corner-tick chat-corner-tick-tl" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-tr" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-bl" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-br" aria-hidden="true" />

      {isDragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center backdrop-blur-[1px]"
          style={{ background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}
        >
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{
                  transformOrigin: "center",
                  animationDelay: `${delay}s`,
                  borderColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
                }}
              />
            ))}
          </div>
          <svg
            width="280"
            height="280"
            viewBox="0 0 140 140"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ filter: "drop-shadow(0 6px 18px color-mix(in srgb, var(--accent) 18%, transparent))" }}
          >
            <rect
              x="28"
              y="44"
              width="84"
              height="60"
              rx="8"
              fill="color-mix(in srgb, var(--accent) 8%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 50%, transparent)"
              strokeWidth="1.8"
            />
            <path
              d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
              fill="color-mix(in srgb, var(--accent) 16%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 40%, transparent)"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <circle
              cx="96"
              cy="58"
              r="8"
              fill="color-mix(in srgb, var(--accent) 22%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 55%, transparent)"
              strokeWidth="1.6"
            />
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43" />
              <line x1="96" y1="70" x2="96" y2="73" />
              <line x1="84" y1="58" x2="81" y2="58" />
              <line x1="108" y1="58" x2="111" y2="58" />
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4" />
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6" />
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4" />
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6" />
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />}

      {extensionCustomUi && <ExtensionCustomPanel request={extensionCustomUi} onInput={sendExtensionCustomInput} />}

      {isEmptyNew ? (
        <div className="relative z-[1] flex min-h-0 flex-[1_1_0] flex-col items-center justify-end overflow-y-auto px-4 pt-8">
          <div className="chat-content-column">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: "var(--text)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--accent)",
                    flexShrink: 0,
                  }}
                >
                  $
                </span>
                <span
                  style={{
                    fontSize: scaledChatFont(22),
                    color: "var(--text)",
                    fontWeight: 700,
                    letterSpacing: "-0.2px",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Pi Agent Desktop
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-conversation-enter relative z-[1] flex min-h-0 flex-[1_1_0] overflow-hidden">
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 0,
                right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
                zIndex: 40,
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
                pointerEvents: "none",
              }}
            >
              <div className="chat-content-column">
                <NoticeShelf notices={notices} floating align="right" />
              </div>
            </div>
            <div ref={scrollContainerRef} className="relative z-[1] flex-1 overflow-y-auto pt-4 [scrollbar-width:none]">
              <div
                style={{
                  paddingLeft: CHAT_COLUMN_PADDING,
                  paddingRight: CHAT_COLUMN_PADDING,
                }}
              >
                <div className="chat-content-column">
                  {(hasOlder || loadingOlder) && (
                    <div
                      ref={olderHistorySentinelRef}
                      style={{ display: "flex", justifyContent: "center", padding: 8 }}
                    >
                      <button
                        type="button"
                        disabled={loadingOlder}
                        onClick={() => void loadOlder()}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 7,
                          background: "var(--bg-panel)",
                          color: "var(--text-muted)",
                          cursor: loadingOlder ? "default" : "pointer",
                          fontSize: scaledChatFont(11),
                          padding: "5px 10px",
                        }}
                      >
                        {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                      </button>
                    </div>
                  )}
                  <ExtensionStatusBar statuses={extensionStatuses} />
                  <ExtensionWidgets widgets={aboveEditorWidgets} />

                  {(() => {
                    let lastUserIdx = -1;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "user") {
                        lastUserIdx = i;
                        break;
                      }
                    }

                    const timestampAssistantIndices = new Set<number>();
                    let foundAssistantInTurn = false;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "user") {
                        foundAssistantInTurn = false;
                      } else if (messages[i].role === "assistant" && !foundAssistantInTurn) {
                        timestampAssistantIndices.add(i);
                        foundAssistantInTurn = true;
                      }
                    }

                    const visibleRefIndexByMessage = new Map<number, number>();
                    let refIdx = 0;
                    messages.forEach((msg, idx) => {
                      if (msg.role === "user" || msg.role === "assistant") {
                        visibleRefIndexByMessage.set(idx, refIdx++);
                      }
                    });

                    const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                      messageRefs.current[refIndex] = el;
                      if (idx === lastUserIdx) {
                        (lastUserMsgRef as { current: HTMLDivElement | null }).current = el;
                      }
                    };

                    const renderMessage = (
                      idx: number,
                      options: {
                        attachRef?: boolean;
                        renderRole?: MessageRenderRole;
                        messageOverride?: AgentMessage;
                        showTimestamp?: boolean;
                      } = {},
                    ): ReactNode => {
                      const msg = options.messageOverride ?? messages[idx];
                      const prevAssistantEntryId =
                        msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                          ? entryIds[idx - 1]
                          : undefined;
                      const isVisible = msg.role === "user" || msg.role === "assistant";
                      const currentRefIdx = visibleRefIndexByMessage.get(idx);
                      const renderRole = options.renderRole ?? "message";
                      const renderKey = messageRenderKeys.keyFor(messages[idx], entryIds[idx], renderRole);
                      const toolData = toolMessageIndex.get(messages[idx]);
                      let showTimestamp = false;
                      if (msg.role === "assistant") {
                        showTimestamp = timestampAssistantIndices.has(idx);
                        // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                        if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                          showTimestamp = false;
                        }
                      }
                      if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                      const view = (
                        <SessionProfiler key={renderKey} id="MessageView">
                          <MessageView
                            message={msg}
                            toolResults={toolData?.results}
                            toolCallDurations={toolData?.durations}
                            modelNames={modelNames}
                            cwd={messageCwd}
                            onOpenFile={onOpenFile}
                            entryId={entryIds[idx]}
                            onFork={
                              agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork
                            }
                            forking={forkingEntryId === entryIds[idx]}
                            onNavigate={agentRunning ? undefined : handleNavigate}
                            prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                            onEditContent={insertEditedContent}
                            onLoadDeferredContent={loadDeferredContent}
                            showTimestamp={showTimestamp}
                            prevTimestamp={
                              idx > 0
                                ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp
                                : undefined
                            }
                            thinkingExpansionStore={thinkingExpansionStore}
                          />
                        </SessionProfiler>
                      );
                      if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                      return (
                        <div key={renderKey} ref={attachVisibleRef(idx, currentRefIdx)}>
                          {view}
                        </div>
                      );
                    };

                    const rendered: ReactNode[] = [];
                    for (let idx = 0; idx < messages.length;) {
                      const msg = messages[idx];
                      if (msg.role !== "user") {
                        rendered.push(renderMessage(idx));
                        idx += 1;
                        continue;
                      }

                      const userIdx = idx;
                      let endIdx = userIdx + 1;
                      while (endIdx < messages.length && messages[endIdx].role !== "user") endIdx += 1;

                      const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                      if (finalAssistantIdx === -1) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(renderMessage(renderIdx));
                        }
                        idx = endIdx;
                        continue;
                      }

                      const isLiveTail =
                        (agentRunning || streamState.isStreaming) &&
                        endIdx === messages.length &&
                        userIdx === lastUserIdx;
                      if (isLiveTail) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(renderMessage(renderIdx));
                        }
                        idx = endIdx;
                        continue;
                      }

                      rendered.push(renderMessage(userIdx));

                      const processIndices: number[] = [];
                      for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                        processIndices.push(processIdx);
                      }
                      const visibleProcessIndices = processIndices.filter((processIdx) =>
                        hasDisplayableProcessMessage(messages[processIdx]),
                      );
                      const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                      const finalParts = getAssistantRenderParts(assistantRenderParts, finalAssistant);
                      const finalProcessMessage = finalParts.processMessage;
                      const finalAnswerMessage = finalParts.answerMessage;

                      const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                      if (processCount > 0) {
                        const processGroupKey = `process-group:${messageRenderKeys.keyFor(
                          messages[userIdx],
                          entryIds[userIdx],
                          "message",
                        )}:${messageRenderKeys.keyFor(
                          messages[finalAssistantIdx],
                          entryIds[finalAssistantIdx],
                          "final",
                        )}`;
                        const processRefIdx =
                          visibleProcessIndices
                            .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                            .find((value): value is number => typeof value === "number") ??
                          (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                        const processGroup = (
                          <ProcessDetailsGroup
                            stateKey={processGroupKey}
                            expansionStore={processDetailsExpansionStore}
                            messageCount={processCount}
                            toolCallCount={
                              countToolCalls(messages, visibleProcessIndices) +
                              countToolCallBlocks(finalParts.processBlocks)
                            }
                          >
                            {visibleProcessIndices.map((processIdx) =>
                              renderMessage(processIdx, { attachRef: false, renderRole: "process" }),
                            )}
                            {finalProcessMessage &&
                              renderMessage(finalAssistantIdx, {
                                attachRef: false,
                                renderRole: "process-final",
                                messageOverride: finalProcessMessage,
                                showTimestamp: false,
                              })}
                          </ProcessDetailsGroup>
                        );
                        rendered.push(
                          <div
                            key={processGroupKey}
                            ref={
                              processRefIdx === undefined
                                ? undefined
                                : (el) => {
                                    messageRefs.current[processRefIdx] = el;
                                  }
                            }
                          >
                            {processGroup}
                          </div>,
                        );
                      }

                      if (finalAnswerMessage) {
                        rendered.push(
                          renderMessage(finalAssistantIdx, {
                            renderRole: "final",
                            messageOverride: finalAnswerMessage,
                          }),
                        );
                      }
                      for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                        rendered.push(renderMessage(renderIdx));
                      }
                      idx = endIdx;
                    }
                    return rendered;
                  })()}

                  {streamState.isStreaming && streamState.streamingMessage && (
                    <SessionProfiler id="MessageView">
                      <MessageView
                        message={streamState.streamingMessage as AgentMessage}
                        isStreaming
                        modelNames={modelNames}
                        cwd={messageCwd}
                        onOpenFile={onOpenFile}
                        entryId="streaming"
                        thinkingExpansionStore={thinkingExpansionStore}
                      />
                    </SessionProfiler>
                  )}

                  {agentRunning && !streamState.streamingMessage && (
                    <div className="py-2 text-[13px] text-text-muted">
                      <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
                    </div>
                  )}

                  <div ref={liveContentEndRef} />

                  {agentRunning && <div data-run-spacer style={{ height: chatViewportHeight }} />}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>
            {isMobile ? null : (
              <SessionProfiler id="ChatMinimap">
                <ChatMinimap
                  messages={minimapMessages}
                  streamingMessage={minimapStreamingMessage}
                  scrollContainer={scrollContainerRef}
                  messageRefs={messageRefs}
                  historyTruncated={hasOlder}
                />
              </SessionProfiler>
            )}

            {/* Floating "scroll to bottom" badge: appears when the chat has
                scrolled away from the newest content. Clicking it snaps to the
                bottom and re-magnets the viewport so streaming thinking/tool
                output keeps the view attached until the user scrolls away. */}
            {isAwayFromBottom && (
              <button
                type="button"
                className="chat-scroll-to-bottom"
                onClick={reattachAutoFollow}
                aria-label={t("scrollToBottom", "Scroll to bottom")}
                title={agentRunning ? t("jumpToLatest", "Jump to latest") : t("scrollToBottom", "Scroll to bottom")}
                style={{
                  bottom: 12,
                  right: isMobile ? 12 : CHAT_MINIMAP_WIDTH + 12,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3.5 6 8 10.5 12.5 6" />
                </svg>
                {agentRunning && (
                  <span
                    aria-hidden="true"
                    className="chat-scroll-to-bottom-live-dot"
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--accent)",
                    }}
                  />
                )}
              </button>
            )}
          </div>
        </>
      )}

      <div
        className="chat-input-transition-dock relative z-[2] w-full flex-shrink-0 self-center"
        data-position={isEmptyNew ? "welcome" : "conversation"}
      >
        {!isEmptyNew && belowEditorWidgets.length > 0 && (
          <div
            style={{
              padding: `0 ${CHAT_COLUMN_PADDING}px`,
              paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
            }}
          >
            <div className="chat-content-column">
              <ExtensionWidgets widgets={belowEditorWidgets} />
            </div>
          </div>
        )}
        {chatInputElement}
      </div>

      <div className="chat-input-bottom-spacer" data-expanded={isEmptyNew ? "true" : "false"} aria-hidden="true" />
    </div>
  );
}

function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: scaledChatFont(12),
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: scaledChatFont(11) }}>
            {status.key}
          </span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "5px 9px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: scaledChatFont(11),
              fontFamily: "var(--font-mono)",
            }}
          >
            {widget.key}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "8px 9px",
              color: "var(--text-muted)",
              fontSize: scaledChatFont(12),
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono)",
            }}
          >
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({
  notices,
  floating = false,
  align = "left",
}: {
  notices: NoticeItem[];
  floating?: boolean;
  align?: "left" | "right";
}) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color =
          notice.type === "error"
            ? "#ef4444"
            : notice.type === "warning"
              ? "#d97706"
              : notice.type === "success"
                ? "#10b981"
                : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                padding: "14px 0",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (
    request: ExtensionDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => void;
}) {
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");

  useEffect(() => {
    setValue(request.method === "editor" ? (request.prefill ?? "") : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: scaledChatFont(14), fontWeight: 650 }}>{request.title}</div>
          <div
            style={{
              marginTop: 3,
              color: "var(--text-dim)",
              fontSize: scaledChatFont(11),
              fontFamily: "var(--font-mono)",
            }}
          >
            extension request
          </div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: scaledChatFont(13),
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {request.message}
            </div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: scaledChatFont(13),
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: scaledChatFont(13),
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: scaledChatFont(13),
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Confirm
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function toTerminalKeyData(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    const ch = e.key.toLowerCase();
    if (ch >= "a" && ch <= "z") {
      return String.fromCharCode(ch.charCodeAt(0) - 96);
    }
  }

  switch (e.key) {
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Enter":
      return "\r";
    case "Escape":
      return "\x1b";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case " ":
      return " ";
    default:
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) return e.key;
      return null;
  }
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) =>
    Object.keys(segment.style).length > 0 ? (
      <span key={`${keyPrefix}-${index}`} style={segment.style}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    panelRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        ref={panelRef}
        tabIndex={0}
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          const data = toTerminalKeyData(e);
          if (!data) return;
          e.preventDefault();
          e.stopPropagation();
          onInput(request, data);
        }}
        style={{
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ color: "var(--text)", fontSize: scaledChatFont(13), fontWeight: 650 }}>Extension panel</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: scaledChatFont(12),
            }}
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: scaledChatFont(13),
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
