import { useEffect, useRef, useState } from "react";
import { listSessions, subscribeSessionsChanged } from "@/lib/api-client";
import { SessionListStore } from "@/lib/session-list-store";
import { connectTimedEventStream, EventStreamConnectionManager } from "@/lib/event-stream-connection";

/** One connection and one list loader for sidebar, deep links and session hydration. */
export function useSessionList(): SessionListStore {
  const [store] = useState(() => new SessionListStore(listSessions));
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
