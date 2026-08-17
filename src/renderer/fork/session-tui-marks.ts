import { useEffect, useState } from "react";

export type SessionTuiMark = "running" | "dead";

export function forkOnKillSession(sessionId: string): void {
  if (!sessionId.trim()) return;
  window.piBridge.killSessionTui?.(sessionId.trim());
}

export function useSessionTuiMarks(): Record<string, SessionTuiMark> {
  const [marks, setMarks] = useState<Record<string, SessionTuiMark>>({});

  useEffect(() => {
    let cancelled = false;
    const apply = (next: Record<string, SessionTuiMark>) => {
      if (!cancelled) setMarks(next);
    };
    void window.piBridge
      .getSessionTuiMarks?.()
      .then(apply)
      .catch(() => undefined);
    const unsubscribe = window.piBridge.onSessionTuiMarks?.(apply);
    const timer = window.setInterval(() => {
      void window.piBridge
        .getSessionTuiMarks?.()
        .then(apply)
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, []);

  return marks;
}
