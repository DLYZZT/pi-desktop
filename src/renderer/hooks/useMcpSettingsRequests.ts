import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SettingsTab } from "../components/SettingsConfig";
import { subscribe } from "@/lib/api-client";

export function useMcpSettingsCommand(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void subscribe("mcp.settings", sessionId, () => {
      if (!disposed) window.dispatchEvent(new CustomEvent("pi-desktop:open-mcp-settings", { detail: { sessionId } }));
    })
      .then((value) => {
        if (disposed) value();
        else off = value;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [sessionId]);
}

export function useMcpSettingsRequests(
  open: Dispatch<SetStateAction<boolean>>,
  tab: Dispatch<SetStateAction<SettingsTab>>,
  session: Dispatch<SetStateAction<string | null>>,
  navigation: Dispatch<SetStateAction<number>>,
): void {
  useEffect(() => {
    const show = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      session(typeof id === "string" ? id : null);
      tab("mcp");
      navigation((value) => value + 1);
      open(true);
    };
    window.addEventListener("pi-desktop:open-mcp-settings", show);
    return () => window.removeEventListener("pi-desktop:open-mcp-settings", show);
  }, [open, tab, session, navigation]);
}
