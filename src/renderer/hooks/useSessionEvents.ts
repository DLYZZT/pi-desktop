import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentEvent } from "@contract/types";
import { subscribeAgentEvents, subscribeSessionsChanged } from "@/lib/api-client";
import { translate } from "@/i18n";
import { SessionRefreshQueue } from "@/lib/session-refresh-queue";
import {
  connectTimedEventStream,
  EventStreamConnectionManager,
  type EventStreamConnectionResult,
  type EventStreamConnectionStatus,
} from "@/lib/event-stream-connection";

const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
/** Backoff for the mount-time agent stream subscription; capped, retried while the view lives. */
const AGENT_EVENTS_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

export class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(`EVENT_STREAM_${status.toUpperCase()}`);
    this.name = "EventStreamConnectionError";
  }
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Owns the two complementary subscriptions for one mounted chat view. */
export function useSessionEvents({
  sessionIdRef,
  onSessionChanged,
  sessionRefreshDelay,
  onAgentEventsError,
  retryWait = waitUnlessAborted,
}: {
  sessionIdRef: RefObject<string | null>;
  onSessionChanged: (sessionId: string) => unknown | Promise<unknown>;
  sessionRefreshDelay?: () => number;
  /** Reported once per failed connection episode, before backoff retries start. */
  onAgentEventsError?: (message: string) => void;
  retryWait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const eventUnsubRef = useRef<(() => void) | null>(null);
  const changesUnsubRef = useRef<(() => void) | null>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const onSessionChangedRef = useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;
  const delayRef = useRef(sessionRefreshDelay);
  delayRef.current = sessionRefreshDelay;
  const onAgentEventsErrorRef = useRef(onAgentEventsError);
  onAgentEventsErrorRef.current = onAgentEventsError;
  const retryWaitRef = useRef(retryWait);
  retryWaitRef.current = retryWait;
  const refreshQueueRef = useRef<SessionRefreshQueue | null>(null);
  const cancelPendingSessionRefresh = useCallback(() => refreshQueueRef.current?.cancel(), []);
  const [events] = useState(() => new EventStreamConnectionManager(eventUnsubRef));
  const [changes] = useState(() => new EventStreamConnectionManager(changesUnsubRef));
  const lifetimeRef = useRef(new AbortController());
  const isActive = useCallback(() => !lifetimeRef.current.signal.aborted, []);
  const getViewSignal = useCallback(() => lifetimeRef.current.signal, []);

  const connectEvents = useCallback(
    async (sid: string, lifetime: AbortSignal = lifetimeRef.current.signal): Promise<EventStreamConnectionResult> => {
      if (lifetime.aborted || sid !== sessionIdRef.current) return { status: "closed", unsubscribe: () => {} };
      return connectTimedEventStream<AgentEvent>({
        manager: events,
        signal: lifetime,
        subscribe: (onEvent) => subscribeAgentEvents(sid, onEvent),
        onEvent: (event) => {
          if (sid === sessionIdRef.current) handleAgentEventRef.current?.(event);
        },
        timeoutMs: EVENT_STREAM_CONNECT_TIMEOUT_MS,
      });
    },
    [events, sessionIdRef],
  );

  const ensureEventsConnected = useCallback(
    async (sid: string) => {
      const result = await connectEvents(sid);
      // A prompt already accepted by the UI may continue in the background.
      // Leaving its view cancels subscriptions, not the authorized backend command.
      if (!isActive() || result.status === "connected") return;
      throw new EventStreamConnectionError(result.status);
    },
    [connectEvents, isActive],
  );

  // Mount-time subscription can lose the race against Host startup; without a
  // retry the view refreshes from disk but silently drops live UI dialogs.
  const connectEventsWithRetry = useCallback(
    async (sid: string, signal: AbortSignal) => {
      for (let attempt = 0; ; attempt++) {
        // A send-path reconnect may have installed a healthy stream meanwhile.
        if (signal.aborted || eventUnsubRef.current) return;
        const result = await connectEvents(sid, signal);
        if (result.status === "connected") return;
        // This attempt's own lifetime, not the ref: a remount (StrictMode's
        // double invoke, or a new session) aborts it and installs a fresh one,
        // and that supersede is not a connection failure worth reporting.
        if (signal.aborted || sid !== sessionIdRef.current) return;
        if (attempt === 0) {
          const error = new EventStreamConnectionError(result.status);
          console.error("Failed to subscribe to agent events:", error);
          onAgentEventsErrorRef.current?.(
            `${translate("agentEventsStreamRetrying", "Live update connection failed; retrying in the background.")} (${error.message})`,
          );
        }
        const delay = AGENT_EVENTS_RETRY_DELAYS_MS[Math.min(attempt, AGENT_EVENTS_RETRY_DELAYS_MS.length - 1)];
        await retryWaitRef.current(delay, signal);
        if (signal.aborted || sid !== sessionIdRef.current) return;
      }
    },
    [connectEvents, sessionIdRef],
  );

  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    const refreshQueue = new SessionRefreshQueue(() => {
      const current = sessionIdRef.current;
      if (current && !lifetime.signal.aborted) return onSessionChangedRef.current(current);
    });
    refreshQueueRef.current = refreshQueue;
    const report = (label: string) => (result: EventStreamConnectionResult) => {
      if (!lifetime.signal.aborted && result.status !== "connected") {
        console.error(`Failed to subscribe to ${label}:`, new EventStreamConnectionError(result.status));
      }
    };
    const sid = sessionIdRef.current;
    if (sid) void connectEventsWithRetry(sid, lifetime.signal);

    // Subscribe independently: persisted changes remain useful when the agent
    // stream is unavailable. The current ID also covers new-session promotion
    // without closing the stream that is already producing the first answer.
    void connectTimedEventStream({
      manager: changes,
      signal: lifetime.signal,
      subscribe: subscribeSessionsChanged,
      onEvent: (event) => {
        const current = sessionIdRef.current;
        if (current && (event.sessionId === current || event.fullRefresh === true)) {
          refreshQueue.request(event.deleted || event.fullRefresh ? 0 : (delayRef.current?.() ?? 0));
        }
      },
      timeoutMs: EVENT_STREAM_CONNECT_TIMEOUT_MS,
    }).then(report("session changes"));

    return () => {
      lifetime.abort();
      refreshQueue.dispose();
      if (refreshQueueRef.current === refreshQueue) refreshQueueRef.current = null;
      events.invalidate();
      changes.invalidate();
    };
  }, [changes, connectEvents, connectEventsWithRetry, events, sessionIdRef]);

  return {
    connectEvents,
    ensureEventsConnected,
    eventUnsubRef,
    handleAgentEventRef,
    isActive,
    getViewSignal,
    cancelPendingSessionRefresh,
  };
}
