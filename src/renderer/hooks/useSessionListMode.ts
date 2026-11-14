import { useEffect, useSyncExternalStore } from "react";
import { sessionListModeController, type SessionListModeSnapshot } from "@/lib/session-list-mode";
import type { SessionListMode } from "@shared/session-list-mode";

export type UseSessionListMode = SessionListModeSnapshot & {
  update: (mode: SessionListMode) => Promise<void>;
};

/** Subscribe to the shared session list mode preference and load it once. */
export function useSessionListMode(): UseSessionListMode {
  const snapshot = useSyncExternalStore(
    sessionListModeController.subscribe,
    sessionListModeController.getSnapshot,
    sessionListModeController.getSnapshot,
  );

  useEffect(() => {
    void sessionListModeController.load();
  }, []);

  return { ...snapshot, update: (mode) => sessionListModeController.update(mode) };
}
