import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { filterDesktopToolNames } from "../shared/pi-tool-policy";

const SESSION_TOOLS_ENTRY = "pi-desktop-session-tools";

type PersistedSessionTools = {
  version: 1;
  toolNames: string[];
};

function parsePersistedSessionTools(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<PersistedSessionTools>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.toolNames) ||
    !state.toolNames.every((name) => typeof name === "string")
  ) {
    return undefined;
  }
  return filterDesktopToolNames(state.toolNames);
}

export function getLegacySessionToolNames(sessionManager: Pick<SessionManager, "getEntries">): string[] | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_TOOLS_ENTRY) continue;
    const toolNames = parsePersistedSessionTools(entry.data);
    if (toolNames !== undefined) return toolNames;
  }
  return undefined;
}
