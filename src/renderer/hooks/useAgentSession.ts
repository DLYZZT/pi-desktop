import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type { AgentMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { AgentEvent, SessionDetail, SessionRuntimeState } from "@contract/types";
import type { SlashCommandInfo } from "@contract/agent-commands";
export type { SlashCommandInfo } from "@contract/agent-commands";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { agentState, newAgent } from "@/lib/api-client";
import { getToolNamesForPreset, getPresetFromTools } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { useSessionEvents } from "./useSessionEvents";
import { requestAutoSessionTitle, shouldAutoTitleMessage } from "../lib/auto-session-title";

import {
  appendLocalHistoryMessage,
  removeLastHistoryMessage,
  replaceLastHistoryMessage,
} from "@/lib/session-history-update";
import { useI18n } from "@/i18n";
import { useSessionModels } from "./useSessionModels";
import { useSessionHistory } from "./useSessionHistory";
import { useChatViewport } from "./useChatViewport";
import { useSessionExtensionUi } from "./useSessionExtensionUi";
import { abortableDelay } from "@/lib/abortable-delay";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import type { SessionPresentationStore } from "@/lib/session-presentation-store";
import { useSessionPresentation } from "./useSessionPresentation";
import { SessionRuntimeGate, type RuntimeSnapshotTicket } from "@/lib/session-runtime-gate";
import { sessionClientErrorMessage } from "@/lib/session-error-message";
import { skillInvocationCommandText } from "@shared/skill-invocation";

import {
  createSessionTurnState,
  readCompactResult,
  reduceSessionTurnState,
  type QueuedMessages,
  type StreamAction,
} from "../lib/session-turn-state";
export type { AgentPhase, CompactResultInfo, QueuedMessages } from "../lib/session-turn-state";

export type SessionData = SessionDetail;
type AgentStateResponse = SessionRuntimeState;

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return {
    steering: (q?.steering ?? []).map(skillInvocationCommandText),
    followUp: (q?.followUp ?? []).map(skillInvocationCommandText),
  };
}

export type { NoticeItem } from "@/lib/notice-queue";

export type BuiltinSlashCommandResult =
  { handled: false } | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
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
  presentationStore?: SessionPresentationStore;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const { t } = useI18n();
  const {
    session,
    newSessionCwd,
    onAgentEnd,
    onSessionCreated,
    onSessionForked,
    modelsRefreshKey,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const [runtimeGate] = useState(() => new SessionRuntimeGate());
  const loadSessionRef = useRef<((sid: string) => Promise<unknown>) | null>(null);
  const { ensureEventsConnected, eventUnsubRef, handleAgentEventRef, isActive, getViewSignal } = useSessionEvents({
    sessionIdRef,
    onSessionChanged: (sid) => {
      void loadSessionRef.current?.(sid);
    },
  });
  const {
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    notices,
    addNotice,
    applyExtensionSnapshot,
    handleExtensionUiRequest,
    respondToExtensionUi,
    sendExtensionCustomInput,
  } = useSessionExtensionUi({
    sessionIdRef,
    getViewSignal,
    runtimeGate,
    chatInputRef: opts.chatInputRef,
  });
  const captureCommandView = useCallback(() => {
    const signal = getViewSignal(),
      sid = sessionIdRef.current;
    return () => !signal.aborted && signal === getViewSignal() && (sid === null || sid === sessionIdRef.current);
  }, [getViewSignal]);
  const toolsRequestGate = useRef(new LatestRequestGate()).current;
  const commandsRequestGate = useRef(new LatestRequestGate()).current;
  const modelRequestGate = useRef(new LatestRequestGate()).current;

  const [turnState, dispatchTurn] = useReducer(reduceSessionTurnState, undefined, createSessionTurnState);
  const {
    streamState,
    agentRunning,
    agentPhase,
    retryInfo,
    isCompacting,
    compactError,
    compactResult,
    queuedMessages,
  } = turnState;
  const dispatch = useCallback((action: StreamAction) => dispatchTurn({ type: "stream", action }), []);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [contextUsage, setContextUsage] = useState<{
    percent: number | null;
    contextWindow: number;
    tokens: number | null;
  } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);

  const {
    modelNames,
    modelList,
    modelCatalog,
    modelRefreshing,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    newSessionModel,
    newSessionDefaultModel,
    setNewSessionModel,
    loadModels,
    refreshModels,
    cancelModelRefresh,
  } = useSessionModels({ isNew, cwd: newSessionCwd ?? session?.cwd, refreshKey: modelsRefreshKey, addNotice });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const agentRunningRef = useRef(false);
  // Preserve the existing imperative handle while publishing render state through the reducer.
  const setAgentRunning = useCallback((value: boolean | ((running: boolean) => boolean)) => {
    const running = typeof value === "function" ? value(agentRunningRef.current) : value;
    agentRunningRef.current = running;
    dispatchTurn({ type: "running", running });
  }, []);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const promptRunIdRef = useRef(0);
  // The counter is local to this view. A restored run belongs to an earlier
  // mount and may legitimately complete with a different clientRunId.
  const ownedPromptRunIdRef = useRef<number | null>(null);
  const externalTurnRunIdRef = useRef<string | null>(null);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const prependAnchorRef = useRef<ReturnType<typeof useChatViewport>["capturePrependAnchor"] | null>(null);
  const capturePrependAnchor = useCallback(() => prependAnchorRef.current?.(), []);
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const applyRuntimeSnapshot = useCallback(
    (snapshot: SessionDetail["agentState"], ticket: RuntimeSnapshotTicket) => {
      const liveState = snapshot?.state;
      if (liveState) {
        if (liveState.contextUsage !== undefined && runtimeGate.accept(ticket, "usage"))
          setContextUsage(liveState.contextUsage ?? null);
        if (liveState.systemPrompt !== undefined && runtimeGate.accept(ticket, "systemPrompt"))
          setSystemPrompt(liveState.systemPrompt ?? null);
        if (liveState.thinkingLevel !== undefined && runtimeGate.accept(ticket, "thinking"))
          setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
        applyExtensionSnapshot(liveState, ticket);
        if (liveState.isCompacting !== undefined && runtimeGate.accept(ticket, "compaction"))
          dispatchTurn({ type: "compaction-state", isCompacting: liveState.isCompacting });
        if (liveState.queuedMessages !== undefined && runtimeGate.accept(ticket, "queue"))
          dispatchTurn({ type: "queue-snapshot", queuedMessages: normalizeQueuedMessages(liveState.queuedMessages) });
      } else if (snapshot && !snapshot.running && runtimeGate.accept(ticket, "queue"))
        dispatchTurn({ type: "queue-snapshot", queuedMessages: { steering: [], followUp: [] } });
    },
    [applyExtensionSnapshot, runtimeGate],
  );
  const applySessionSnapshot = useCallback(
    (d: SessionDetail, ticket = runtimeGate.capture()) => {
      setSessionStatsOverride(null);
      if (d.toolNames !== undefined) {
        setToolPresetState(getPresetFromTools(d.toolNames.map((name) => ({ name, description: "", active: true }))));
      }
      setCurrentModelOverride(null);
      applyRuntimeSnapshot(d.agentState, ticket);
      if (
        !d.agentState?.state?.thinkingLevel &&
        d.context.thinkingLevel &&
        d.context.thinkingLevel !== "off" &&
        runtimeGate.accept(ticket, "thinking")
      ) {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
    },
    [applyRuntimeSnapshot, runtimeGate, setToolPresetState],
  );
  const prepareSessionSnapshot = useCallback(() => {
    const ticket = runtimeGate.capture();
    return (detail: SessionDetail) => applySessionSnapshot(detail, ticket);
  }, [applySessionSnapshot, runtimeGate]);
  const {
    data,
    loading,
    error,
    activeLeafId,
    messages,
    entryIds,
    previousCursor,
    historyRevision,
    loadingOlder,
    setData,
    setActiveLeafId,
    setMessages,
    updateHistory,
    loadSession,
    loadContext,
    loadOlder,
    loadDeferredContent,
    resetHistory,
    invalidateHistory,
    beginNavigation,
  } = useSessionHistory({
    isNew,
    sessionIdRef,
    capturePrependAnchor,
    onSessionLoaded: applySessionSnapshot,
    prepareSessionSnapshot,
  });
  loadSessionRef.current = loadSession;
  const viewport = useChatViewport({
    agentRunning,
    agentRunningRef,
    agentPhase,
    streamState,
    messageCount: messages.length,
    loading,
  });
  prependAnchorRef.current = viewport.capturePrependAnchor;
  const {
    isAwayFromBottom,
    reattachAutoFollow,
    beginLocalTurn,
    beginExternalTurn,
    endExternalTurn,
    prepareSessionChange,
    restoreFollowAfterLoad,
    messagesEndRef,
    liveContentEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    pendingScrollToUserRef,
    initialScrollDoneRef,
  } = viewport;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = (() => {
    const stats = sessionStatsOverride ?? data?.stats;
    if (!stats) return null;
    return {
      ...stats,
      sessionName: data?.info ? data.info.name : (stats.sessionName ?? session?.name),
      ...(contextUsage ? { contextUsage } : {}),
    };
  })();
  useSessionPresentation(opts.presentationStore, {
    sessionId: sessionIdRef.current,
    info: data?.info ?? session,
    stats: sessionStats,
    contextUsage,
  });

  const loadTools = useCallback(
    async (sid: string) => {
      const ownsView = captureCommandView(),
        request = toolsRequestGate.begin();
      if (!ownsView()) return;
      try {
        const tools = await sendAgentCommand(sid, { type: "get_tools" });
        if (tools && ownsView() && toolsRequestGate.isCurrent(request) && sessionIdRef.current === sid) {
          setToolPresetState(getPresetFromTools(tools));
        }
      } catch (e) {
        console.error("Failed to load tools:", e);
      }
    },
    [captureCommandView, setToolPresetState, toolsRequestGate],
  );

  const promoteNewSession = useCallback(
    (messageCount = 0, firstMessage = "(no messages)") => {
      const sid = sessionIdRef.current;
      if (!isActive() || !isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
      newSessionPromotedRef.current = true;
      onSessionCreated?.({
        id: sid,
        path: "",
        cwd: newSessionCwd,
        name: undefined,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount,
        firstMessage,
      });
    },
    [isActive, isNew, newSessionCwd, onSessionCreated],
  );

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const result = await newAgent({
        cwd: newSessionCwd,
        type: "ensure_session",
        toolNames,
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
      });
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel]);

  const loadSlashCommands = useCallback(async () => {
    const ownsView = captureCommandView(),
      request = commandsRequestGate.begin();
    const isCurrent = () => ownsView() && commandsRequestGate.isCurrent(request);
    if (!isCurrent()) return [] as SlashCommandInfo[];
    const sid = sessionIdRef.current ?? (await ensureNewSession());
    if (!isCurrent()) return [] as SlashCommandInfo[];
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand(sid, { type: "get_commands" });
      if (!isCurrent()) return [] as SlashCommandInfo[];
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      if (!isCurrent()) return [] as SlashCommandInfo[];
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      if (isCurrent()) setSlashCommandsLoading(false);
    }
  }, [captureCommandView, commandsRequestGate, ensureNewSession]);

  const finishPromptWithoutStream = useCallback(
    async (sid: string | null = sessionIdRef.current, runId?: number) => {
      // Bail out before loadSession too: a stale finish for a previous run
      // must not overwrite the messages of the run currently streaming.
      const ticket = runtimeGate.capture();
      const ownsRun = () =>
        isActive() &&
        sessionIdRef.current === sid &&
        runtimeGate.isCurrentRun(ticket) &&
        (runId === undefined || promptRunIdRef.current === runId);
      if (!ownsRun()) return;
      try {
        if (sid) await loadSession(sid, false, true, false, ownsRun);
      } finally {
        if (!ownsRun()) return;
        optimisticUserMessageKeyRef.current = null;
        if (!agentRunningRef.current) return;
        agentRunningRef.current = false;
        runtimeGate.beginRun();
        dispatchTurn({ type: "settled" });
        onAgentEnd?.();
      }
    },
    [isActive, loadSession, onAgentEnd, runtimeGate],
  );

  const waitForPromptSettlement = useCallback(
    async (sid: string, runId?: number) => {
      const signal = getViewSignal();
      const ticket = runtimeGate.capture();
      const ownsRun = () =>
        isActive() &&
        sessionIdRef.current === sid &&
        runtimeGate.isCurrent(ticket, "run") &&
        (runId === undefined || promptRunIdRef.current === runId);
      if (!(await abortableDelay(PROMPT_SETTLE_INITIAL_DELAY_MS, signal))) return;
      const startedAt = Date.now();

      while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
        if (!ownsRun()) return;
        try {
          try {
            const data = await agentState(sid);
            if (!ownsRun()) return;
            const state = data.state as AgentStateResponse | undefined;
            if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
              await finishPromptWithoutStream(sid, runId);
              return;
            }
          } catch {
            // ignore single poll failure
          }
        } catch {
          // The live MessagePort stream remains the primary completion path.
        }
        if (!(await abortableDelay(PROMPT_SETTLE_POLL_MS, signal))) return;
      }
    },
    [finishPromptWithoutStream, getViewSignal, isActive, runtimeGate],
  );

  // Reconcile client streaming state with the server. When stream events are
  // missed (renderer suspension, backgrounded tab, or a restarted Host),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(
    async (sid: string) => {
      if (!isActive() || !agentRunningRef.current) return;
      const runId = promptRunIdRef.current;
      const ticket = runtimeGate.capture();
      try {
        const data = await agentState(sid);
        // A slow response can straddle a run boundary (previous run finished
        // and the user already started the next one while this request was in
        // flight) — everything in it is stale, drop it.
        if (!isActive() || sessionIdRef.current !== sid || !runtimeGate.isCurrentRun(ticket)) return;
        const state = (data.state ?? undefined) as AgentStateResponse | undefined;
        // Mirror compaction state unconditionally: a missed compaction_end
        // would otherwise leave the "Stop compaction" UI stuck. No state
        // (wrapper destroyed) means nothing is compacting.
        const canSettle =
          runtimeGate.isCurrent(ticket, "run") &&
          runtimeGate.isCurrent(ticket, "compaction") &&
          runtimeGate.isCurrent(ticket, "queue");
        if (runtimeGate.accept(ticket, "compaction"))
          dispatchTurn({ type: "compaction-state", isCompacting: state?.isCompacting ?? false });
        if (runtimeGate.accept(ticket, "queue"))
          dispatchTurn({ type: "queue-snapshot", queuedMessages: normalizeQueuedMessages(state?.queuedMessages) });
        const busy = data.running && state && (state.isStreaming || state.isPromptRunning || state.isCompacting);
        if (!canSettle || busy || !agentRunningRef.current) return;
        applyRuntimeSnapshot({ running: data.running, state }, ticket);
        await finishPromptWithoutStream(sid, runId);
      } catch {
        // Network still down — the next poll / visibility / online tick retries.
      }
    },
    [applyRuntimeSnapshot, finishPromptWithoutStream, isActive, runtimeGate],
  );

  // Recovery net for missed stream events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      if (!isActive()) return;
      if (
        (event.type === "prompt_done" || event.type === "prompt_error") &&
        typeof event.clientRunId === "number" &&
        ((ownedPromptRunIdRef.current !== null && event.clientRunId !== ownedPromptRunIdRef.current) ||
          externalTurnRunIdRef.current !== null)
      )
        return;
      if (
        (event.type === "channel_turn_end" || event.type === "channel_turn_error") &&
        externalTurnRunIdRef.current !== event.runId
      )
        return;
      if (event.type === "agent_start" || event.type === "channel_turn_start") runtimeGate.beginRun();
      if (event.type === "prompt_done" || event.type === "channel_turn_end" || event.type === "channel_turn_error")
        runtimeGate.touch("run");
      if (event.type === "queue_update") runtimeGate.touch("queue");
      if (["auto_compaction_start", "compaction_start", "auto_compaction_end", "compaction_end"].includes(event.type))
        runtimeGate.touch("compaction");
      dispatchTurn({ type: "event", event });
      switch (event.type) {
        case "channel_turn_start": {
          ownedPromptRunIdRef.current = null;
          externalTurnRunIdRef.current = typeof event.runId === "string" ? event.runId : null;
          beginExternalTurn();
          break;
        }
        case "channel_turn_end":
        case "channel_turn_error": {
          if (externalTurnRunIdRef.current !== event.runId) break;
          externalTurnRunIdRef.current = null;
          endExternalTurn();
          if (agentRunningRef.current) void finishPromptWithoutStream(sessionIdRef.current);
          break;
        }
        case "agent_start":
          agentRunningRef.current = true;
          break;
        case "agent_end":
          // One Desktop prompt may have several SDK runs (retry, boundary continuation).
          // The wrapper emits prompt_done only after the whole operation settles.
          break;
        case "prompt_done": {
          const clientRunId =
            ownedPromptRunIdRef.current !== null && typeof event.clientRunId === "number"
              ? event.clientRunId
              : undefined;
          if (!agentRunningRef.current) break;
          void finishPromptWithoutStream(sessionIdRef.current, clientRunId);
          break;
        }
        case "prompt_error":
          addNotice({
            type: "error",
            message: (event.errorMessage as string | undefined) ?? t("commandFailed", "Command failed"),
          });
          break;
        case "extension_error":
          addNotice({
            type: "error",
            message: (event.error as string | undefined) ?? t("extensionCommandFailed", "Extension command failed"),
          });
          break;
        case "message_end": {
          // Same late-event guard: after reconcile finished this run,
          // loadSession already loaded this message from the session file —
          // appending it again would duplicate it.
          if (!agentRunningRef.current) break;
          if ((event.message as { role?: unknown } | undefined)?.role === "system") break;
          const completed = event.message as AgentMessage | undefined;
          if (completed && completed.role === "user") {
            // Delivered steering/follow-up messages surface here as user
            // messages. The run's initial prompt also emits one, but handleSend
            // already appended it optimistically. Consume only the still-adjacent
            // optimistic bubble; later same-text queue deliveries must render.
            const delivered = normalizeToolCalls(completed);
            const deliveredKey = userMessageKey(delivered);
            const optimisticKey = optimisticUserMessageKeyRef.current;
            optimisticUserMessageKeyRef.current = null;
            updateHistory((current) => {
              const last = current.messages[current.messages.length - 1];
              if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
                return optimisticKey === deliveredKey ? current : replaceLastHistoryMessage(current, delivered);
              }
              return appendLocalHistoryMessage(current, delivered);
            });
          } else if (completed) {
            updateHistory((current) => appendLocalHistoryMessage(current, normalizeToolCalls(completed)));
          }
          break;
        }
        case "auto_compaction_end":
        case "compaction_end":
          if (!event.errorMessage && !event.aborted && sessionIdRef.current) void loadSession(sessionIdRef.current);
          break;
        case "extension_ui_request":
          handleExtensionUiRequest(event as ExtensionUiRequest);
          break;
      }
    },
    [
      addNotice,
      beginExternalTurn,
      endExternalTurn,
      finishPromptWithoutStream,
      handleExtensionUiRequest,
      isActive,
      loadSession,
      runtimeGate,
      t,
      updateHistory,
    ],
  );
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(
    async (message: string, images?: AttachedImage[]) => {
      const trimmedMessage = message.trim();
      if (!trimmedMessage && !images?.length) return;
      if (!isActive() || agentRunningRef.current) return;
      const ownsView = captureCommandView();
      const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");
      const promptRunId = promptRunIdRef.current + 1;
      runtimeGate.beginRun();

      const imageBlocks = images?.map((img) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
      }));
      const userMsg: AgentMessage = {
        role: "user",
        content: imageBlocks?.length
          ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
          : message,
        timestamp: Date.now(),
      };
      updateHistory((current) => appendLocalHistoryMessage(current, userMsg));
      optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
      promptRunIdRef.current = promptRunId;
      ownedPromptRunIdRef.current = promptRunId;
      externalTurnRunIdRef.current = null;
      agentRunningRef.current = true;
      dispatchTurn({ type: "start", phase: isSlashCommandPrompt ? "running_command" : "waiting_model" });
      beginLocalTurn();

      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

      try {
        let sentSessionId: string | null = null;
        if (isNew && newSessionCwd) {
          const selectedModel = newSessionModel;
          const existingSid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
          const sid = existingSid ?? (await ensureNewSession());

          if (sid) {
            sentSessionId = sid;
            if (selectedModel) {
              setPendingModel(selectedModel);
              if (existingSid) {
                await sendAgentCommand(sid, {
                  type: "set_model",
                  provider: selectedModel.provider,
                  modelId: selectedModel.modelId,
                });
              }
            }
            await ensureEventsConnected(sid);
            await sendAgentCommand(sid, {
              type: "prompt",
              message,
              clientRunId: promptRunId,
              ...(piImages?.length ? { images: piImages } : {}),
            });
            promoteNewSession(1, message);
            // Auto-title the brand-new session from its first message. Fire and
            // forget: generation is a silent background LLM request and the Host
            // applies it with a rename guard (a manual rename always wins).
            const titleModel = newSessionModel ?? newSessionDefaultModel;
            if (shouldAutoTitleMessage(trimmedMessage)) {
              void requestAutoSessionTitle({
                sessionId: sid,
                message: trimmedMessage,
                ...(titleModel ? { provider: titleModel.provider, modelId: titleModel.modelId } : {}),
              });
            }
          }
        } else if (session) {
          sentSessionId = session.id;
          await ensureEventsConnected(session.id);
          await sendAgentCommand(session.id, {
            type: "prompt",
            message,
            clientRunId: promptRunId,
            ...(piImages?.length ? { images: piImages } : {}),
          });
        }
        if (isSlashCommandPrompt && sentSessionId) {
          void waitForPromptSettlement(sentSessionId, promptRunId);
        }
      } catch (e) {
        console.error("Failed to send message:", e);
        if (!ownsView() || ownedPromptRunIdRef.current !== promptRunId) throw e;
        const optimisticKey = optimisticUserMessageKeyRef.current;
        if (optimisticKey) {
          updateHistory((current) => {
            const last = current.messages[current.messages.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? removeLastHistoryMessage(current)
              : current;
          });
        }
        addNotice({
          type: "error",
          message: sessionClientErrorMessage(e, t, t("messageSendFailed", "Failed to send message.")),
        });
        optimisticUserMessageKeyRef.current = null;
        agentRunningRef.current = false;
        dispatchTurn({ type: "send-failed" });
        // ISSUE-006: rethrow so ChatInput restores the draft
        throw e;
      }
    },
    [
      isNew,
      beginLocalTurn,
      captureCommandView,
      newSessionCwd,
      newSessionModel,
      newSessionDefaultModel,
      session,
      t,
      isActive,
      ensureNewSession,
      ensureEventsConnected,
      promoteNewSession,
      runtimeGate,
      waitForPromptSettlement,
      addNotice,
      updateHistory,
    ],
  );

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(
    async (entryId: string) => {
      const sid = sessionIdRef.current;
      const ownsView = captureCommandView();
      if (!sid || !ownsView()) return;
      setForkingEntryId(entryId);
      try {
        const result = await sendAgentCommand(sid, {
          type: "fork",
          entryId,
        });
        if (ownsView() && !result.cancelled && result.newSessionId) {
          onSessionForked?.(result.newSessionId);
        }
      } catch (e) {
        console.error("Fork failed:", e);
      } finally {
        if (ownsView()) setForkingEntryId(null);
      }
    },
    [captureCommandView, onSessionForked],
  );

  const handleNavigate = useCallback(
    async (entryId: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      // ISSUE-007: navigate first, then load context for that leaf
      const navigation = beginNavigation();
      if (!navigation.isCurrent()) return;
      try {
        await sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId });
      } catch (e) {
        navigation.cancel();
        if (navigation.isCurrent()) console.error("navigate_tree failed:", e);
        return;
      }
      if (!navigation.isCurrent()) return;
      setActiveLeafId(entryId);
      await loadContext(sid, entryId);
    },
    [beginNavigation, loadContext, setActiveLeafId],
  );

  const handleLeafChange = useCallback(
    async (leafId: string | null) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const navigation = beginNavigation();
      if (!navigation.isCurrent()) return;
      if (leafId) {
        try {
          await sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId });
        } catch (e) {
          navigation.cancel();
          if (navigation.isCurrent()) console.error("navigate_tree failed:", e);
          return;
        }
      }
      if (!navigation.isCurrent()) return;
      setActiveLeafId(leafId);
      await loadContext(sid, leafId);
    },
    [beginNavigation, loadContext, setActiveLeafId],
  );

  const handleLeafChangeFromUi = useCallback(
    (leafId: string | null) => {
      void handleLeafChange(leafId);
    },
    [handleLeafChange],
  );

  const handleModelChange = useCallback(
    async (provider: string, modelId: string) => {
      const ownsView = captureCommandView(),
        request = modelRequestGate.begin();
      if (!ownsView()) return;
      if (isNew) {
        setNewSessionModel({ provider, modelId });
        setPendingModel({ provider, modelId });
        const sid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
        if (!sid) return;
        try {
          await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        } catch (e) {
          console.error("Failed to set model:", e);
        }
        return;
      }
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        if (ownsView() && modelRequestGate.isCurrent(request)) setCurrentModelOverride({ provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
    },
    [captureCommandView, isNew, modelRequestGate, setNewSessionModel],
  );

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    const ownsView = captureCommandView();
    if (!sid || isCompacting || !ownsView()) return;
    runtimeGate.touch("compaction");
    dispatchTurn({ type: "compaction-start" });
    try {
      const result = await sendAgentCommand(sid, { type: "compact" });
      if (!ownsView()) return;
      dispatchTurn({ type: "compaction-result", result: readCompactResult(result, "manual") });
      await loadSession(sid, true);
    } catch (e) {
      if (!ownsView()) return;
      dispatchTurn({ type: "compaction-error", error: e instanceof Error ? e.message : String(e) });
      dispatchTurn({ type: "compaction-result", result: null });
    } finally {
      if (ownsView()) dispatchTurn({ type: "compaction-state", isCompacting: false });
    }
  }, [captureCommandView, isCompacting, loadSession, runtimeGate]);

  const handleBuiltinSlashCommand = useCallback(
    async (text: string): Promise<BuiltinSlashCommandResult> => {
      if (!text.startsWith("/")) return { handled: false };
      const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (!match) return { handled: false };

      const [, commandName, rawArgs = ""] = match;
      const ownsView = captureCommandView();
      if (!ownsView()) return { handled: true };
      const args = rawArgs.trim();
      const sid = sessionIdRef.current ?? (await ensureNewSession());
      const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
        if (!ownsView()) return { handled: true };
        if (!result.handled) return result;
        if (result.error) {
          addNotice({ type: "error", message: result.error });
        } else if (result.action !== "openSessionStats") {
          addNotice({ type: "success", message: result.message ?? t("commandCompleted", "Command completed") });
        }
        return result;
      };

      try {
        switch (commandName) {
          case "compact": {
            if (!sid || isCompacting) {
              return complete({
                handled: true,
                error: t("noActiveSessionToCompact", "No active session to compact"),
              });
            }
            runtimeGate.touch("compaction");
            dispatchTurn({ type: "compaction-start" });
            const result = await sendAgentCommand(sid, {
              type: "compact",
              ...(args ? { customInstructions: args } : {}),
            });
            if (!ownsView()) return { handled: true };
            dispatchTurn({ type: "compaction-result", result: readCompactResult(result, "manual") });
            if (await loadSession(sid, true)) promoteNewSession();
            return complete({ handled: true, message: t("contextCompacted", "Compacted context") });
          }

          case "reload": {
            if (!sid) {
              return complete({ handled: true, error: t("noActiveSessionToReload", "No active session to reload") });
            }
            await sendAgentCommand(sid, { type: "reload" });
            if (!ownsView()) return { handled: true };
            await Promise.all([loadSession(sid, false, true), loadTools(sid), loadSlashCommands(), loadModels()]);
            return complete({
              handled: true,
              message: t("sessionResourcesReloaded", "Reloaded session resources"),
            });
          }

          case "name": {
            if (!sid) {
              return complete({ handled: true, error: t("noActiveSessionToName", "No active session to name") });
            }
            if (!args) return complete({ handled: true, error: t("nameCommandUsage", "Usage: /name <name>") });
            await sendAgentCommand(sid, { type: "set_session_name", name: args });
            if (await loadSession(sid)) promoteNewSession();
            return complete({
              handled: true,
              message: t("sessionRenamedTo", "Session renamed to {name}").replace("{name}", args),
            });
          }

          case "session": {
            if (!sid) return complete({ handled: true, error: t("noActiveSession", "No active session") });
            const stats = await sendAgentCommand(sid, { type: "get_session_stats" });
            if (!ownsView()) return { handled: true };
            if (stats) {
              setSessionStatsOverride(stats);
            }
            onSessionStatsPanelOpen?.();
            return complete({ handled: true, action: "openSessionStats" });
          }

          case "copy": {
            if (!sid) return complete({ handled: true, error: t("noActiveSession", "No active session") });
            const data = await sendAgentCommand(sid, { type: "get_last_assistant_text" });
            if (!ownsView()) return { handled: true };
            const textToCopy = data?.text ?? "";
            if (!textToCopy) {
              return complete({
                handled: true,
                error: t("noAssistantMessageToCopy", "No assistant message to copy"),
              });
            }
            await navigator.clipboard.writeText(textToCopy);
            return complete({
              handled: true,
              message: t("copiedLastAssistantMessage", "Copied last assistant message"),
            });
          }

          default:
            return { handled: false };
        }
      } catch (e) {
        return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (ownsView() && commandName === "compact") dispatchTurn({ type: "compaction-state", isCompacting: false });
      }
    },
    [
      addNotice,
      captureCommandView,
      ensureNewSession,
      isCompacting,
      loadModels,
      loadSession,
      loadSlashCommands,
      loadTools,
      promoteNewSession,
      runtimeGate,
      onSessionStatsPanelOpen,
      t,
    ],
  );

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(
    async (message: string, images?: AttachedImage[]) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        const error = new Error("The active session is no longer available");
        addNotice({
          type: "error",
          message: t("steerFailedNotQueued", "Unable to steer the running agent. The message was not queued."),
        });
        throw error;
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "steer",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } catch (error) {
        console.error("Failed to steer:", error);
        addNotice({
          type: "error",
          message: t("steerFailedNotQueued", "Unable to steer the running agent. The message was not queued."),
        });
        throw error;
      }
    },
    [addNotice, t],
  );

  const handlePromptWithStreamingBehavior = useCallback(
    async (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        const error = new Error("The active session is no longer available");
        addNotice({
          type: "error",
          message: t("promptQueueFailedNotQueued", "Unable to queue this prompt. The message was not queued."),
        });
        throw error;
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "prompt",
          message,
          streamingBehavior: behavior,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } catch (error) {
        console.error("Failed to queue prompt:", error);
        addNotice({
          type: "error",
          message: t("promptQueueFailedNotQueued", "Unable to queue this prompt. The message was not queued."),
        });
        throw error;
      }
    },
    [addNotice, t],
  );

  const handleFollowUp = useCallback(
    async (message: string, images?: AttachedImage[]) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        const error = new Error("The active session is no longer available");
        addNotice({
          type: "error",
          message: t("followUpQueueFailedNotQueued", "Unable to queue this follow-up. The message was not queued."),
        });
        throw error;
      }
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "follow_up",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } catch (error) {
        console.error("Failed to follow up:", error);
        addNotice({
          type: "error",
          message: t("followUpQueueFailedNotQueued", "Unable to queue this follow-up. The message was not queued."),
        });
        throw error;
      }
    },
    [addNotice, t],
  );

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    const ownsView = captureCommandView();
    if (!sid || !ownsView()) return;
    const snapshot = runtimeGate.capture();
    try {
      const result = await sendAgentCommand(sid, { type: "clear_queue" });
      if (!ownsView()) return;
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while the stream is connected — clear locally so idle recalls update the UI.
      if (runtimeGate.accept(snapshot, "queue"))
        dispatchTurn({ type: "queue-snapshot", queuedMessages: { steering: [], followUp: [] } });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])].map(skillInvocationCommandText);
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: t("queuedMessagesRecallFailed", "Failed to recall queued messages") });
    }
  }, [captureCommandView, opts.chatInputRef, addNotice, runtimeGate, t]);

  const handleThinkingLevelChange = useCallback(
    async (level: ThinkingLevelOption) => {
      if (!isActive()) return;
      runtimeGate.touch("thinking");
      setThinkingLevel(level);
      if (level === "auto") return; // "auto" leaves pi's current setting untouched
      const sid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_thinking_level", level });
      } catch (e) {
        console.error("Failed to set thinking level:", e);
      }
    },
    [isActive, runtimeGate],
  );

  const handleToolPresetChange = useCallback(
    async (preset: "none" | "default" | "full") => {
      if (!isActive()) return;
      toolsRequestGate.invalidate();
      const toolNames = getToolNamesForPreset(preset);
      setToolPresetState(preset);
      const sid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_tools", toolNames });
      } catch (e) {
        console.error("Failed to set tools:", e);
      }
    },
    [isActive, setToolPresetState, toolsRequestGate],
  );

  // Load session on mount
  useEffect(() => {
    let disposed = false;
    resetHistory();
    if (session) {
      prepareSessionChange();
      sessionIdRef.current = session.id;
      const ticket = runtimeGate.capture();
      void loadSession(session.id, true, true, true).then((agentState) => {
        if (disposed) return;
        restoreFollowAfterLoad();
        if (agentState?.running && runtimeGate.accept(ticket, "run")) {
          void loadTools(session.id);
          if (!agentRunningRef.current && (agentState.state?.isStreaming || agentState.state?.isPromptRunning)) {
            agentRunningRef.current = true;
            dispatchTurn({ type: "start", phase: agentState.state.isStreaming ? "waiting_model" : "running_command" });
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
        }
        applyRuntimeSnapshot(agentState ?? undefined, ticket);
      });
    }
    return () => {
      disposed = true;
      invalidateHistory();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session identity owns this lifecycle effect.
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChangeFromUi);
  }, [data?.tree, activeLeafId, handleLeafChangeFromUi, onBranchDataChange]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => dispatchTurn({ type: "compaction-error", error: null }), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => dispatchTurn({ type: "compaction-result", result: null }), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data,
    loading,
    error,
    activeLeafId,
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
    newSessionModel,
    toolPreset,
    thinkingLevel,
    retryInfo,
    contextUsage,
    systemPrompt,
    forkingEntryId,
    isCompacting,
    compactError,
    compactResult,
    currentModel,
    displayModel,
    sessionStats,
    slashCommands,
    slashCommandsLoading,
    queuedMessages,
    hasOlder: previousCursor !== null,
    loadingOlder,
    historyRevision,
    notices,
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    respondToExtensionUi,
    sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    // "Scroll to bottom" affordance state + action
    isAwayFromBottom,
    reattachAutoFollow,
    // Refs
    sessionIdRef,
    eventUnsubRef,
    messagesEndRef,
    liveContentEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    pendingScrollToUserRef,
    initialScrollDoneRef,
    // Actions
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
    loadTools,
    loadSlashCommands,
    loadOlder,
    loadDeferredContent,
    setActiveLeafId,
    setData,
    setMessages,
    dispatch,
    setAgentRunning,
    setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}
