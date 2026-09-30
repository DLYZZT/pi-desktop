import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SettingsTab } from "../components/SettingsConfig";

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
