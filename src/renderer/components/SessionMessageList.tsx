import { TranscriptNotices } from "./TranscriptNotices";
import { memo, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";
import {
  getDisplayableAssistantBlocks,
  isAssistantFailure,
  isAssistantAborted,
  splitFinalAssistantBlocks,
} from "@/lib/message-display";
import type { MessageRenderKeyRegistry, MessageRenderRole } from "@/lib/message-render-key";
import type { ToolMessageIndex } from "@/lib/tool-message-index";
import { withGeneratedImageReply } from "@/lib/generated-image-reply";
import { MessageView } from "./MessageView";
import { ProcessDetailsGroup } from "./ProcessDetailsGroup";
import { readPlaceholderModel } from "./ToolResultImages";
import { SessionProfiler } from "./SessionProfiler";

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  if (isAssistantFailure(message as AssistantMessage) || isAssistantAborted(message as AssistantMessage)) return true;
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

function summarizeProcessTools(
  messages: AgentMessage[],
  indices: number[],
  index: ReturnType<ToolMessageIndex["build"]>,
) {
  let count = 0;
  const readWarnings = new Set<string>();
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    for (const block of getDisplayableAssistantBlocks(msg)) {
      if (block.type !== "toolCall") continue;
      count++;
      if (block.toolName !== "read") continue;
      const result = index.get(msg)?.results.get(block.toolCallId);
      const model = result && readPlaceholderModel(block.toolName, result);
      if (model) readWarnings.add(model);
    }
  }
  return { toolCallCount: count, readWarnings: [...readWarnings] };
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return (
    message.role === "custom" &&
    !(message.customType === "pi-desktop-transcript-notice" && message.transcriptNotices?.length)
  );
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

export type AssistantRenderPartsCache = WeakMap<AssistantMessage, AssistantRenderParts>;

function getAssistantRenderParts(cache: AssistantRenderPartsCache, message: AssistantMessage): AssistantRenderParts {
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
        : isAssistantFailure(message) || isAssistantAborted(message)
          ? withAssistantBlocks(message, [])
          : null,
  };
  cache.set(message, created);
  return created;
}

type MessageViewProps = ComponentProps<typeof MessageView>;

type SessionMessageListProps = {
  messages: AgentMessage[];
  retryInfo?: import("@contract/types").SessionRetryInfo | null;
  sessionId?: string;
  entryIds: (string | undefined)[];
  agentRunning: boolean;
  isStreaming: boolean;
  isNew: boolean;
  runningToolCallIds: MessageViewProps["runningToolCallIds"];
  toolMessageIndex: ReturnType<ToolMessageIndex["build"]>;
  modelNames: MessageViewProps["modelNames"];
  messageCwd: string | undefined;
  forkingEntryId: string | null | undefined;
  onOpenFile: MessageViewProps["onOpenFile"];
  onFork: MessageViewProps["onFork"];
  onNavigate: MessageViewProps["onNavigate"];
  onEditContent: MessageViewProps["onEditContent"];
  onLoadDeferredContent: MessageViewProps["onLoadDeferredContent"];
  thinkingExpansionStore: MessageViewProps["thinkingExpansionStore"];
  processDetailsExpansionStore: ComponentProps<typeof ProcessDetailsGroup>["expansionStore"];
  messageRenderKeys: MessageRenderKeyRegistry;
  assistantRenderParts: AssistantRenderPartsCache;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  lastUserMsgRef: RefObject<HTMLDivElement | null>;
};

/**
 * The settled part of the conversation. It is memoized on the history and turn
 * state only, so streaming updates of the live tail do not regroup or
 * reconcile the message list.
 */
export const SessionMessageList = memo(function SessionMessageList({
  messages,
  retryInfo,
  sessionId,
  entryIds,
  agentRunning,
  isStreaming,
  isNew,
  runningToolCallIds,
  toolMessageIndex,
  modelNames,
  messageCwd,
  forkingEntryId,
  onOpenFile,
  onFork: handleFork,
  onNavigate: handleNavigate,
  onEditContent: insertEditedContent,
  onLoadDeferredContent: loadDeferredContent,
  thinkingExpansionStore,
  processDetailsExpansionStore,
  messageRenderKeys,
  assistantRenderParts,
  messageRefs,
  lastUserMsgRef,
}: SessionMessageListProps) {
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

  const failedAttempt = retryInfo
    ? messages.findLastIndex(
        (m, i) =>
          i > lastUserIdx &&
          m.role === "assistant" &&
          isAssistantFailure(m) &&
          (retryInfo.failedMessageTimestamp !== undefined
            ? m.timestamp === retryInfo.failedMessageTimestamp
            : m.errorMessage === retryInfo.errorMessage),
      )
    : -1;
  const renderMessage = (
    idx: number,
    options: {
      attachRef?: boolean;
      renderRole?: MessageRenderRole;
      messageOverride?: AgentMessage;
      showTimestamp?: boolean;
    } = {},
  ): ReactNode => {
    let msg = options.messageOverride ?? messages[idx];
    if (idx === failedAttempt && msg.role === "assistant")
      msg = withAssistantBlocks(msg, msg.content, { omitFailure: true });
    if (msg.role === "custom" && msg.customType === "pi-desktop-transcript-notice" && msg.transcriptNotices?.length)
      return null;
    const prevAssistantEntryId =
      msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant" ? entryIds[idx - 1] : undefined;
    const isVisible = msg.role === "user" || msg.role === "assistant";
    const currentRefIdx = visibleRefIndexByMessage.get(idx);
    const renderRole = options.renderRole ?? "message";
    const renderKey = messageRenderKeys.keyFor(messages[idx], entryIds[idx], renderRole);
    const toolData = toolMessageIndex.get(messages[idx]);
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = timestampAssistantIndices.has(idx);
      // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
      if (showTimestamp && isStreaming && idx === messages.length - 1) {
        showTimestamp = false;
      }
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    const view = (
      <SessionProfiler key={renderKey} id="MessageView">
        <MessageView
          sessionId={sessionId}
          message={msg}
          toolResults={toolData?.results}
          toolCallDurations={toolData?.durations}
          runningToolCallIds={runningToolCallIds}
          modelNames={modelNames}
          cwd={messageCwd}
          onOpenFile={onOpenFile}
          entryId={entryIds[idx]}
          onFork={agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
          forking={forkingEntryId === entryIds[idx]}
          onNavigate={agentRunning ? undefined : handleNavigate}
          prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
          onEditContent={insertEditedContent}
          onLoadDeferredContent={loadDeferredContent}
          showTimestamp={showTimestamp}
          prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
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
  function renderNotices(start: number, end: number) {
    const notices = messages.slice(start, end).flatMap((message) => message.transcriptNotices ?? []);
    if (notices.length)
      rendered.push(<TranscriptNotices key={`notices:${entryIds[start] ?? start}`} notices={notices} />);
  }
  for (let idx = 0; idx < messages.length;) {
    const msg = messages[idx];
    if (msg.role !== "user") {
      rendered.push(renderMessage(idx));
      renderNotices(idx, idx + 1);
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx].role !== "user" && messages[endIdx].role !== "bashExecution")
      endIdx += 1;

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

    if (finalAssistantIdx === -1) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rendered.push(renderMessage(renderIdx));
      }
      renderNotices(userIdx, endIdx);
      idx = endIdx;
      continue;
    }

    const isLiveTail = (agentRunning || isStreaming) && endIdx === messages.length && userIdx === lastUserIdx;
    if (isLiveTail) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rendered.push(renderMessage(renderIdx));
      }
      renderNotices(userIdx, endIdx);
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
    const finalAnswerMessage = withGeneratedImageReply(
      finalParts.answerMessage,
      finalAssistant,
      messages,
      userIdx + 1,
      endIdx,
    );

    const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
    if (processCount > 0) {
      const processGroupKey = `process-group:${messageRenderKeys.keyFor(
        messages[userIdx],
        entryIds[userIdx],
        "message",
      )}:${messageRenderKeys.keyFor(messages[finalAssistantIdx], entryIds[finalAssistantIdx], "final")}`;
      const processRefIdx =
        visibleProcessIndices
          .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
          .find((value): value is number => typeof value === "number") ??
        (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
      const processGroup = (
        <ProcessDetailsGroup
          {...summarizeProcessTools(messages, [...visibleProcessIndices, finalAssistantIdx], toolMessageIndex)}
          stateKey={processGroupKey}
          expansionStore={processDetailsExpansionStore}
          messageCount={processCount}
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
    renderNotices(userIdx, endIdx);
    idx = endIdx;
  }
  return rendered;
});
