import { useEffect, useRef, useState } from "react";
import { subscribeSessionsChanged } from "@/lib/api-client";
import { SessionListStore, type SessionListData } from "@/lib/session-list-store";
import { connectTimedEventStream, EventStreamConnectionManager } from "@/lib/event-stream-connection";

export class SessionListResponseError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail || `Failed to load sessions (${status})`);
  }
}

// Keep the existing compatibility transport while changing state ownership.
// Plan 22-05 migrates this adapter after the shared lifecycle is verified.
async function loadSessionList(): Promise<SessionListData> {
  const response = await fetch("/api/sessions");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new SessionListResponseError(response.status, body.error);
  }
  const data = (await response.json()) as Partial<SessionListData>;
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    runningSessionIds: data.runningSessionIds ?? [],
  };
}

/** One connection and one list loader for sidebar, deep links and session hydration. */
export function useSessionList(): SessionListStore {
  const [store] = useState(() => new SessionListStore(loadSessionList));
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [connection] = useState(() => new EventStreamConnectionManager(unsubscribeRef));
  useEffect(() => {
    const lifetime = new AbortController();
    const release = store.activate();
    void connectTimedEventStream({
      manager: connection,
      signal: lifetime.signal,
      subscribe: subscribeSessionsChanged,
      onEvent: store.applyChange,
      timeoutMs: 5_000,
    }).then((result) => {
      if (lifetime.signal.aborted) return;
      store.setLive(result.status === "connected");
      // Read after installation so initial index changes cannot fall into a gap.
      // A user-triggered read already in flight needs one reconciliation pass.
      store.invalidate();
    });
    return () => {
      lifetime.abort();
      connection.invalidate();
      release();
    };
  }, [connection, store]);
  return store;
}
