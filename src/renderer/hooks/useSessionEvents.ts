import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentEvent } from "@contract/types";
import { subscribeAgentEvents, subscribeSessionsChanged } from "@/lib/api-client";
import {
  connectTimedEventStream,
  EventStreamConnectionManager,
  type EventStreamConnectionResult,
  type EventStreamConnectionStatus,
} from "@/lib/event-stream-connection";

const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;

export class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(`EVENT_STREAM_${status.toUpperCase()}`);
    this.name = "EventStreamConnectionError";
  }
}

/** Owns the two complementary subscriptions for one mounted chat view. */
export function useSessionEvents({
  sessionIdRef,
  onSessionChanged,
}: {
  sessionIdRef: RefObject<string | null>;
  onSessionChanged: (sessionId: string) => void;
}) {
  const eventUnsubRef = useRef<(() => void) | null>(null);
  const changesUnsubRef = useRef<(() => void) | null>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const onSessionChangedRef = useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;
  const [events] = useState(() => new EventStreamConnectionManager(eventUnsubRef));
  const [changes] = useState(() => new EventStreamConnectionManager(changesUnsubRef));
  const lifetimeRef = useRef(new AbortController());
  const isActive = useCallback(() => !lifetimeRef.current.signal.aborted, []);
  const getViewSignal = useCallback(() => lifetimeRef.current.signal, []);

  const connectEvents = useCallback(
    async (sid: string): Promise<EventStreamConnectionResult> => {
      const signal = lifetimeRef.current.signal;
      if (signal.aborted || sid !== sessionIdRef.current) return { status: "closed", unsubscribe: () => {} };
      return connectTimedEventStream<AgentEvent>({
        manager: events,
        signal,
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

  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    const report = (label: string) => (result: EventStreamConnectionResult) => {
      if (!lifetime.signal.aborted && result.status !== "connected") {
        console.error(`Failed to subscribe to ${label}:`, new EventStreamConnectionError(result.status));
      }
    };
    const sid = sessionIdRef.current;
    if (sid) void connectEvents(sid).then(report("agent events"));

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
          onSessionChangedRef.current(current);
        }
      },
      timeoutMs: EVENT_STREAM_CONNECT_TIMEOUT_MS,
    }).then(report("session changes"));

    return () => {
      lifetime.abort();
      events.invalidate();
      changes.invalidate();
    };
  }, [changes, connectEvents, events, sessionIdRef]);

  return { connectEvents, ensureEventsConnected, eventUnsubRef, handleAgentEventRef, isActive, getViewSignal };
}
