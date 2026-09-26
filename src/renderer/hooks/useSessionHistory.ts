import { useCallback, useEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import type { SessionDetail, EntryContentResult } from "@contract/types";
import type { AgentMessage } from "@/lib/types";
import { getSession, getSessionContext, getSessionContextPage, getSessionEntryContent } from "@/lib/api-client";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { mergeHistoryTail, prependHistoryPage } from "@/lib/session-pagination";
import { normalizeSessionHistory, type SessionHistoryValue } from "@/lib/session-history-update";
import {
  consumeSessionLoadTrace,
  failSessionLoadTrace,
  finishSessionLoadTrace,
  logSessionPerformanceEvent,
  markSessionLoadPhase,
  type SessionLoadTrace,
} from "@/lib/session-performance";
import { sessionClientErrorMessage } from "@/lib/session-error-message";
import { useI18n } from "@/i18n";

const INITIAL_HISTORY_TURNS = 20;
const HISTORY_PAGE_MAX_BYTES = 1024 * 1024;
const DEFERRED_CONTENT_CACHE_SIZE = 12;
type HistoryScope = { sessionId: string; generation: number };
type PageRequest = HistoryScope & { cursor: string; revision: string };
type DeferredContent = EntryContentResult["content"];

function hasRpcCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export interface SessionHistoryOptions {
  isNew: boolean;
  sessionIdRef: RefObject<string | null>;
  capturePrependAnchor?: () => (() => void) | undefined;
  onSessionLoaded: (detail: SessionDetail) => void;
}

/** Owns persisted history and the lifetime of every request that can publish it. */
export function useSessionHistory({
  isNew,
  sessionIdRef,
  capturePrependAnchor,
  onSessionLoaded,
}: SessionHistoryOptions) {
  const { t } = useI18n();
  const [data, setData] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, publishMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [previousCursor, setPreviousCursor] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const activeRef = useRef(true);
  const historyGenerationRef = useRef(0);
  const detailGateRef = useRef(new LatestRequestGate());
  const loadingOwnerRef = useRef<number | null>(null);
  const historyRevisionRef = useRef<string | null>(null);
  const previousCursorRef = useRef<string | null>(null);
  const loadedMessagesRef = useRef<AgentMessage[]>([]);
  const loadedEntryIdsRef = useRef<string[]>([]);
  const olderRequestRef = useRef<PageRequest | null>(null);
  const deferredContentCacheRef = useRef(new Map<string, DeferredContent>());
  const deferredContentRequestRef = useRef(new Map<string, Promise<DeferredContent>>());
  const pendingSessionLoadTraceRef = useRef<SessionLoadTrace | null>(null);
  const anchorFrameRef = useRef<number | null>(null);

  const isCurrent = useCallback(
    (scope: HistoryScope) =>
      activeRef.current &&
      sessionIdRef.current === scope.sessionId &&
      historyGenerationRef.current === scope.generation,
    [sessionIdRef],
  );

  const invalidateHistory = useCallback(() => {
    historyGenerationRef.current++;
    detailGateRef.current.invalidate();
    loadingOwnerRef.current = null;
    olderRequestRef.current = null;
    deferredContentCacheRef.current.clear();
    deferredContentRequestRef.current.clear();
    if (anchorFrameRef.current !== null) cancelAnimationFrame(anchorFrameRef.current);
    anchorFrameRef.current = null;
    const trace = pendingSessionLoadTraceRef.current;
    pendingSessionLoadTraceRef.current = null;
    if (trace) failSessionLoadTrace(trace);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      invalidateHistory();
    };
  }, [invalidateHistory]);

  const commitHistory = useCallback((nextMessages: AgentMessage[], nextEntryIds: string[]) => {
    const normalized = normalizeSessionHistory(nextMessages, nextEntryIds);
    loadedMessagesRef.current = normalized.messages;
    loadedEntryIdsRef.current = normalized.entryIds;
    publishMessages(normalized.messages);
    setEntryIds(normalized.entryIds);
  }, []);

  const updateHistory = useCallback(
    (update: (current: SessionHistoryValue) => SessionHistoryValue) => {
      const next = update({ messages: loadedMessagesRef.current, entryIds: loadedEntryIdsRef.current });
      commitHistory(next.messages, next.entryIds);
    },
    [commitHistory],
  );

  const setMessages = useCallback(
    (next: SetStateAction<AgentMessage[]>) => {
      commitHistory(typeof next === "function" ? next(loadedMessagesRef.current) : next, loadedEntryIdsRef.current);
    },
    [commitHistory],
  );

  const updatePagingState = useCallback((revision: string, cursor?: string) => {
    historyRevisionRef.current = revision;
    previousCursorRef.current = cursor ?? null;
    setHistoryRevision(revision);
    setPreviousCursor(cursor ?? null);
  }, []);

  const resetHistory = useCallback(
    (showLoading = !isNew) => {
      invalidateHistory();
      historyRevisionRef.current = null;
      previousCursorRef.current = null;
      commitHistory([], []);
      setData(null);
      setActiveLeafId(null);
      setError(null);
      setHistoryRevision(null);
      setPreviousCursor(null);
      setLoadingOlder(false);
      setLoading(showLoading);
    },
    [commitHistory, invalidateHistory, isNew],
  );

  const beginNavigation = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!activeRef.current || !sid) return { isCurrent: () => false, cancel: () => {} };
    const previousCursor = previousCursorRef.current;
    const previousRevision = historyRevisionRef.current;
    invalidateHistory();
    const scope = { sessionId: sid, generation: historyGenerationRef.current };
    previousCursorRef.current = null;
    setPreviousCursor(null);
    setLoading(false);
    setLoadingOlder(false);
    const ownsNavigation = () => isCurrent(scope);
    return {
      isCurrent: ownsNavigation,
      cancel: () => {
        if (!ownsNavigation() || historyRevisionRef.current !== previousRevision) return;
        previousCursorRef.current = previousCursor;
        setPreviousCursor(previousCursor);
      },
    };
  }, [invalidateHistory, isCurrent, sessionIdRef]);

  const loadSession = useCallback(
    async (sid: string, showLoading = false, includeState = false, reset = false) => {
      if (!activeRef.current || sessionIdRef.current !== sid) return null;
      const showSpinner = showLoading || loadingOwnerRef.current !== null;
      if (reset) {
        invalidateHistory();
        setLoadingOlder(false);
      }
      const scope = { sessionId: sid, generation: historyGenerationRef.current };
      const request = detailGateRef.current.begin();
      const ownsView = () => isCurrent(scope) && detailGateRef.current.isCurrent(request);
      if (showSpinner) {
        loadingOwnerRef.current = request;
        setLoading(true);
      }
      const trace = consumeSessionLoadTrace(sid, showLoading ? "initial" : "refresh");
      let traceFailed = false;
      const failTrace = () => {
        if (!traceFailed) failSessionLoadTrace(trace);
        traceFailed = true;
      };
      try {
        markSessionLoadPhase(trace, "rpc-start");
        const detail = await getSession(sid, includeState, trace.id, {
          maxTurns: INITIAL_HISTORY_TURNS,
          maxBytes: HISTORY_PAGE_MAX_BYTES,
        });
        markSessionLoadPhase(trace, "rpc-end");
        if (!ownsView()) {
          failTrace();
          // History freshness is separate from an initial caller's runtime hydration.
          // Preserve that return value only while its session/branch scope is still current.
          return isCurrent(scope) ? (detail.agentState ?? null) : null;
        }
        setData(detail);
        setActiveLeafId(detail.leafId);
        const previousTrace = pendingSessionLoadTraceRef.current;
        if (previousTrace && previousTrace !== trace) failSessionLoadTrace(previousTrace);
        pendingSessionLoadTraceRef.current = trace;
        const merged = mergeHistoryTail(
          {
            messages: loadedMessagesRef.current,
            entryIds: loadedEntryIdsRef.current,
            revision: historyRevisionRef.current,
            previousCursor: previousCursorRef.current,
          },
          detail.context,
          reset,
        );
        if (merged.revision !== historyRevisionRef.current) {
          olderRequestRef.current = null;
          setLoadingOlder(false);
          deferredContentCacheRef.current.clear();
          deferredContentRequestRef.current.clear();
        }
        commitHistory(merged.messages, merged.entryIds);
        updatePagingState(merged.revision!, merged.previousCursor ?? undefined);
        setError(null);
        onSessionLoaded(detail);
        return detail.agentState ?? null;
      } catch (cause) {
        failTrace();
        if (!ownsView()) return null;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (hasRpcCode(cause, "NOT_FOUND") || message.includes("not found") || message.includes("NOT_FOUND")) {
          if (showLoading) resetHistory(false);
          return null;
        }
        setError(sessionClientErrorMessage(cause, t, t("sessionLoadFailed", "Failed to load session.")));
        return null;
      } finally {
        if (isCurrent(scope) && loadingOwnerRef.current === request) {
          loadingOwnerRef.current = null;
          setLoading(false);
        }
      }
    },
    [commitHistory, invalidateHistory, isCurrent, onSessionLoaded, resetHistory, sessionIdRef, t, updatePagingState],
  );

  useEffect(() => {
    const trace = pendingSessionLoadTraceRef.current;
    if (!trace) return;
    pendingSessionLoadTraceRef.current = null;
    markSessionLoadPhase(trace, "react-commit");
    let finished = false;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        finished = true;
        finishSessionLoadTrace(trace);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
      if (!finished) failSessionLoadTrace(trace);
    };
  }, [messages]);

  const loadContext = useCallback(
    async (sid: string, leafId: string | null) => {
      if (!activeRef.current || sessionIdRef.current !== sid) return;
      const navigation = beginNavigation();
      try {
        const result = await getSessionContext(sid, leafId ?? undefined, {
          maxTurns: INITIAL_HISTORY_TURNS,
          maxBytes: HISTORY_PAGE_MAX_BYTES,
        });
        if (!navigation.isCurrent()) return;
        commitHistory(result.context.messages, result.context.entryIds ?? []);
        updatePagingState(result.context.historyRevision, result.context.previousCursor);
        setError(null);
      } catch (cause) {
        if (!navigation.isCurrent()) return;
        navigation.cancel();
        setError(sessionClientErrorMessage(cause, t, t("sessionLoadFailed", "Failed to load session.")));
      }
    },
    [beginNavigation, commitHistory, sessionIdRef, t, updatePagingState],
  );

  const loadOlder = useCallback(async () => {
    const sid = sessionIdRef.current,
      cursor = previousCursorRef.current,
      revision = historyRevisionRef.current;
    if (!activeRef.current || !sid || !cursor || !revision || olderRequestRef.current?.cursor === cursor) return;
    const request = { sessionId: sid, cursor, revision, generation: historyGenerationRef.current };
    const ownsPage = () => isCurrent(request) && historyRevisionRef.current === revision;
    const startedAt = performance.now();
    let outcome = "ok";
    olderRequestRef.current = request;
    setLoadingOlder(true);
    try {
      const page = await getSessionContextPage(sid, cursor, INITIAL_HISTORY_TURNS, HISTORY_PAGE_MAX_BYTES);
      if (!ownsPage()) {
        outcome = "discarded";
        return;
      }
      const prepended = prependHistoryPage(
        {
          messages: loadedMessagesRef.current,
          entryIds: loadedEntryIdsRef.current,
          revision,
          previousCursor: previousCursorRef.current,
        },
        page.context,
      );
      if (!prepended) {
        outcome = "revision-reset";
        await loadSession(sid, false, false, true);
        return;
      }
      const restoreAnchor = capturePrependAnchor?.();
      commitHistory(prepended.messages, prepended.entryIds);
      updatePagingState(revision, prepended.previousCursor ?? undefined);
      if (anchorFrameRef.current !== null) cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = requestAnimationFrame(() => {
        anchorFrameRef.current = null;
        if (ownsPage()) restoreAnchor?.();
      });
    } catch (cause) {
      if (!ownsPage()) {
        outcome = "discarded";
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (hasRpcCode(cause, "STALE_CURSOR") || message.includes("STALE_CURSOR")) {
        outcome = "stale-reset";
        await loadSession(sid, false, false, true);
      } else {
        outcome = "error";
        console.error("Failed to load older session history:", cause);
      }
    } finally {
      if (olderRequestRef.current === request) {
        olderRequestRef.current = null;
        if (isCurrent(request)) setLoadingOlder(false);
      }
      logSessionPerformanceEvent("history-page", {
        outcome,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
    }
  }, [capturePrependAnchor, commitHistory, isCurrent, loadSession, sessionIdRef, updatePagingState]);

  const loadDeferredContent = useCallback(
    async (entryId: string, blockIndex = 0) => {
      const sid = sessionIdRef.current;
      if (!sid || !activeRef.current) return;
      const scope = { sessionId: sid, generation: historyGenerationRef.current };
      const revision = historyRevisionRef.current;
      const ownsContent = () => isCurrent(scope) && revision === historyRevisionRef.current;
      const key = `${sid}:${entryId}:${blockIndex}`;
      let content = deferredContentCacheRef.current.get(key);
      if (content === undefined) {
        let request = deferredContentRequestRef.current.get(key);
        if (!request) {
          request = getSessionEntryContent(sid, entryId, blockIndex).then((result) => result.content);
          deferredContentRequestRef.current.set(key, request);
        }
        try {
          content = await request;
        } catch (cause) {
          if (ownsContent()) throw cause;
          return;
        } finally {
          if (deferredContentRequestRef.current.get(key) === request) deferredContentRequestRef.current.delete(key);
        }
        if (!ownsContent()) return;
        const cache = deferredContentCacheRef.current;
        cache.delete(key);
        cache.set(key, content);
        while (cache.size > DEFERRED_CONTENT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
      }
      if (!ownsContent()) return;
      const nextMessages = loadedMessagesRef.current.map((message, index) => {
        if (loadedEntryIdsRef.current[index] !== entryId || !Array.isArray(message.content)) return message;
        return {
          ...message,
          content: message.content.map((block, position) =>
            position === blockIndex && "deferredContent" in block ? content : block,
          ),
        } as AgentMessage;
      });
      commitHistory(nextMessages, loadedEntryIdsRef.current);
    },
    [commitHistory, isCurrent, sessionIdRef],
  );

  return {
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
  };
}
