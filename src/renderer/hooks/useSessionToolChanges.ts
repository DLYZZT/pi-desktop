import { useEffect, type RefObject } from "react";

export function useSessionToolChanges(session: RefObject<string | null>, refresh: (id: string) => Promise<void>): void {
  useEffect(() => {
    const changed = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (id && session.current === id) void refresh(id);
    };
    window.addEventListener("pi-desktop:session-tools-changed", changed);
    return () => window.removeEventListener("pi-desktop:session-tools-changed", changed);
  }, [session, refresh]);
}
