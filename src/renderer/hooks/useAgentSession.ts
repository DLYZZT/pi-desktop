import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import type { AgentEvent, SessionDetail, SessionRuntimeState } from "@contract/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { agentState, newAgent } from "@/lib/api-client";
import { getToolNamesForPreset, getPresetFromTools, type ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { useSessionEvents } from "./useSessionEvents";
import { requestAutoSessionTitle, shouldAutoTitleMessage } from "../lib/auto-session-title";

import {
  appendLocalHistoryMessage,
  removeLastHistoryMessage,
  replaceLastHistoryMessage,
} from "@/lib/session-history-update";
import { NOTICE_VISIBLE_MS, noticeExpiryDelay, noticeReducer, type NoticeType } from "@/lib/notice-queue";
import { useI18n } from "@/i18n";
import { useSessionModels } from "./useSessionModels";
import { useSessionHistory } from "./useSessionHistory";
import { useChatViewport } from "./useChatViewport";
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

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return {
    steering: (q?.steering ?? []).map(skillInvocationCommandText),
    followUp: (q?.followUp ?? []).map(skillInvocationCommandText),
  };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type { NoticeItem } from "@/lib/notice-queue";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

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
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const NOTICE_EXIT_ANIMATION_MS = 180;

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

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
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
        expiresAt: Date.now() + NOTICE_VISIBLE_MS,
      },
    });
  }, []);

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
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
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
  const externalTurnRunIdRef = useRef<string | null>(null);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const prependAnchorRef = useRef<ReturnType<typeof useChatViewport>["capturePrependAnchor"] | null>(null);
  const capturePrependAnchor = useCallback(() => prependAnchorRef.current?.(), []);
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const applySessionSnapshot = useCallback(
    (d: SessionDetail) => {
      setSessionStatsOverride(null);
      if (d.toolNames !== undefined) {
        setToolPresetState(getPresetFromTools(d.toolNames.map((name) => ({ name, description: "", active: true }))));
      }
      setCurrentModelOverride(null);
      const liveState = d.agentState?.state;
      if (liveState) {
        if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
        if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
        if (liveState.thinkingLevel !== undefined)
          setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
        if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
        if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
        if (liveState.queuedMessages !== undefined)
          dispatchTurn({ type: "queue-snapshot", queuedMessages: normalizeQueuedMessages(liveState.queuedMessages) });
      } else if (d.agentState && !d.agentState.running)
        dispatchTurn({ type: "queue-snapshot", queuedMessages: { steering: [], followUp: [] } });
      if (!liveState?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
    },
    [setToolPresetState],
  );
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
  } = useSessionHistory({ isNew, sessionIdRef, capturePrependAnchor, onSessionLoaded: applySessionSnapshot });
  const { ensureEventsConnected, eventUnsubRef, handleAgentEventRef, isActive } = useSessionEvents({
    sessionIdRef,
    onSessionChanged: (sid) => {
      void loadSession(sid);
    },
  });
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
    if (sessionStatsOverride) return sessionStatsOverride;
    if (!data?.stats) return null;
    return {
      ...data.stats,
      sessionName: session?.name ?? data.stats.sessionName,
      ...(contextUsage ? { contextUsage } : {}),
    };
  })();

  const loadTools = useCallback(
    async (sid: string) => {
      try {
        const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
        if (tools && sessionIdRef.current === sid) {
          setToolPresetState(getPresetFromTools(tools));
        }
      } catch (e) {
        console.error("Failed to load tools:", e);
      }
    },
    [setToolPresetState],
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
    const sid = sessionIdRef.current ?? (await ensureNewSession());
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const respondToExtensionUi = useCallback(
    async (
      request: ExtensionUiDialogRequest,
      response: { value: string } | { confirmed: boolean } | { cancelled: true },
    ) => {
      const sid = sessionIdRef.current;
      setExtensionDialog((current) => (current?.id === request.id ? null : current));
      if (!sid) return;
      try {
        await sendAgentCommand(sid, {
          type: "extension_ui_response",
          id: request.id,
          ...response,
        });
      } catch (e) {
        console.error("Failed to send extension UI response:", e);
      }
    },
    [],
  );

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const handleExtensionUiRequest = useCallback(
    (request: ExtensionUiRequest) => {
      switch (request.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          setExtensionDialog(request);
          break;
        case "notify": {
          addNotice({
            id: request.id,
            message: request.message,
            type: request.notifyType ?? "info",
          });
          break;
        }
        case "setStatus":
          setExtensionStatuses((prev) => {
            const rest = prev.filter((item) => item.key !== request.statusKey);
            return request.statusText ? [...rest, { key: request.statusKey, text: request.statusText }] : rest;
          });
          break;
        case "setWidget":
          setExtensionWidgets((prev) => {
            const rest = prev.filter((item) => item.key !== request.widgetKey);
            return request.widgetLines
              ? [
                  ...rest,
                  {
                    key: request.widgetKey,
                    lines: request.widgetLines,
                    placement: request.widgetPlacement ?? "aboveEditor",
                  },
                ]
              : rest;
          });
          break;
        case "setTitle":
          if (request.title) document.title = request.title;
          break;
        case "set_editor_text":
          opts.chatInputRef?.current?.insertText(request.text);
          break;
        case "custom":
          setExtensionCustomUi((current) => {
            if (request.closed) return current?.id === request.id ? null : current;
            return request;
          });
          break;
      }
    },
    [addNotice, opts.chatInputRef],
  );

  const finishPromptWithoutStream = useCallback(
    async (sid: string | null = sessionIdRef.current, runId?: number) => {
      // Bail out before loadSession too: a stale finish for a previous run
      // must not overwrite the messages of the run currently streaming.
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        if (sid) await loadSession(sid, false, true);
      } finally {
        if (runId !== undefined && promptRunIdRef.current !== runId) return;
        optimisticUserMessageKeyRef.current = null;
        if (!agentRunningRef.current) return;
        agentRunningRef.current = false;
        dispatchTurn({ type: "settled" });
        onAgentEnd?.();
      }
    },
    [loadSession, onAgentEnd],
  );

  const waitForPromptSettlement = useCallback(
    async (sid: string, runId?: number) => {
      await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
      const startedAt = Date.now();

      while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
        if (runId !== undefined && promptRunIdRef.current !== runId) return;
        try {
          try {
            const data = await agentState(sid);
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
        await delay(PROMPT_SETTLE_POLL_MS);
      }
    },
    [finishPromptWithoutStream],
  );

  // Reconcile client streaming state with the server. When stream events are
  // missed (renderer suspension, backgrounded tab, or a restarted Host),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(
    async (sid: string) => {
      if (!agentRunningRef.current) return;
      const runId = promptRunIdRef.current;
      try {
        const data = await agentState(sid);
        // A slow response can straddle a run boundary (previous run finished
        // and the user already started the next one while this request was in
        // flight) — everything in it is stale, drop it.
        if (promptRunIdRef.current !== runId) return;
        const state = (data.state ?? undefined) as AgentStateResponse | undefined;
        // Mirror compaction state unconditionally: a missed compaction_end
        // would otherwise leave the "Stop compaction" UI stuck. No state
        // (wrapper destroyed) means nothing is compacting.
        dispatchTurn({ type: "compaction-state", isCompacting: state?.isCompacting ?? false });
        dispatchTurn({ type: "queue-snapshot", queuedMessages: normalizeQueuedMessages(state?.queuedMessages) });
        const busy = data.running && state && (state.isStreaming || state.isPromptRunning || state.isCompacting);
        if (busy || !agentRunningRef.current) return;
        if (state) {
          if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
          if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
          if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
          if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
        }
        await finishPromptWithoutStream(sid, runId);
      } catch {
        // Network still down — the next poll / visibility / online tick retries.
      }
    },
    [finishPromptWithoutStream],
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
      dispatchTurn({ type: "event", event });
      switch (event.type) {
        case "channel_turn_start": {
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
          const clientRunId = typeof event.clientRunId === "number" ? event.clientRunId : undefined;
          if (clientRunId !== undefined && clientRunId !== promptRunIdRef.current) break;
          if (!agentRunningRef.current) break;
          void finishPromptWithoutStream(sessionIdRef.current, clientRunId);
          break;
        }
        case "prompt_error":
          if (typeof event.clientRunId === "number" && event.clientRunId !== promptRunIdRef.current) break;
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
      loadSession,
      t,
      updateHistory,
    ],
  );
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(
    async (message: string, images?: AttachedImage[]) => {
      const trimmedMessage = message.trim();
      if (!trimmedMessage && !images?.length) return;
      if (agentRunning) return;
      const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");
      const promptRunId = promptRunIdRef.current + 1;

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
      newSessionCwd,
      newSessionModel,
      newSessionDefaultModel,
      session,
      t,
      agentRunning,
      ensureNewSession,
      ensureEventsConnected,
      promoteNewSession,
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
      if (!sid) return;
      setForkingEntryId(entryId);
      try {
        const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
          type: "fork",
          entryId,
        });
        const { cancelled, newSessionId } = result ?? {};
        if (isActive() && !cancelled && newSessionId) {
          onSessionForked?.(newSessionId);
        }
      } catch (e) {
        console.error("Fork failed:", e);
      } finally {
        setForkingEntryId(null);
      }
    },
    [isActive, onSessionForked],
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
        setCurrentModelOverride({ provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
    },
    [isNew, setNewSessionModel],
  );

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    dispatchTurn({ type: "compaction-start" });
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      dispatchTurn({ type: "compaction-result", result: readCompactResult(result, "manual") });
      await loadSession(sid, true);
    } catch (e) {
      dispatchTurn({ type: "compaction-error", error: e instanceof Error ? e.message : String(e) });
      dispatchTurn({ type: "compaction-result", result: null });
    } finally {
      dispatchTurn({ type: "compaction-state", isCompacting: false });
    }
  }, [isCompacting, loadSession]);

  const handleBuiltinSlashCommand = useCallback(
    async (text: string): Promise<BuiltinSlashCommandResult> => {
      if (!text.startsWith("/")) return { handled: false };
      const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (!match) return { handled: false };

      const [, commandName, rawArgs = ""] = match;
      const args = rawArgs.trim();
      const sid = sessionIdRef.current ?? (await ensureNewSession());
      const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
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
            dispatchTurn({ type: "compaction-start" });
            const result = await sendAgentCommand<CompactCommandResult>(sid, {
              type: "compact",
              ...(args ? { customInstructions: args } : {}),
            });
            dispatchTurn({ type: "compaction-result", result: readCompactResult(result, "manual") });
            if (await loadSession(sid, true)) promoteNewSession();
            return complete({ handled: true, message: t("contextCompacted", "Compacted context") });
          }

          case "reload": {
            if (!sid) {
              return complete({ handled: true, error: t("noActiveSessionToReload", "No active session to reload") });
            }
            await sendAgentCommand(sid, { type: "reload" });
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
            const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
            if (stats) {
              setSessionStatsOverride(stats);
            }
            onSessionStatsPanelOpen?.();
            return complete({ handled: true, action: "openSessionStats" });
          }

          case "copy": {
            if (!sid) return complete({ handled: true, error: t("noActiveSession", "No active session") });
            const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
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
        if (commandName === "compact") dispatchTurn({ type: "compaction-state", isCompacting: false });
      }
    },
    [
      addNotice,
      ensureNewSession,
      isCompacting,
      loadModels,
      loadSession,
      loadSlashCommands,
      loadTools,
      promoteNewSession,
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
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while the stream is connected — clear locally so idle recalls update the UI.
      dispatchTurn({ type: "queue-snapshot", queuedMessages: { steering: [], followUp: [] } });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])].map(skillInvocationCommandText);
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: t("queuedMessagesRecallFailed", "Failed to recall queued messages") });
    }
  }, [opts.chatInputRef, addNotice, t]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleToolPresetChange = useCallback(
    async (preset: "none" | "default" | "full") => {
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
    [setToolPresetState],
  );

  // Load session on mount
  useEffect(() => {
    let disposed = false;
    resetHistory();
    if (session) {
      prepareSessionChange();
      sessionIdRef.current = session.id;

      void loadSession(session.id, true, true, true).then((agentState) => {
        if (disposed) return;
        restoreFollowAfterLoad();
        if (agentState?.running) {
          void loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            agentRunningRef.current = true;
            dispatchTurn({ type: "start", phase: agentState.state.isStreaming ? "waiting_model" : "running_command" });
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined)
            dispatchTurn({ type: "compaction-state", isCompacting: agentState.state.isCompacting });
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined)
            setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined)
            setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined)
            setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined)
            dispatchTurn({
              type: "queue-snapshot",
              queuedMessages: normalizeQueuedMessages(agentState.state.queuedMessages),
            });
        }
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
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id, now: Date.now() });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(
      () => {
        dispatchNotice({ type: "mark_oldest_exiting" });
      },
      noticeExpiryDelay(oldest, Date.now()),
    );
    return () => clearTimeout(t);
  }, [noticeState.visible]);

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
    notices: noticeState.visible,
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
