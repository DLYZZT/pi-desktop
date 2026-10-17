import { useAgentShell, type AgentShell } from "../shared/agent-shell.ts";
import { PRESET_DEFAULT } from "../shared/tool-presets.ts";
import { agentShellPreferences } from "./agent-shell-settings.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getDefaultStore } from "./session-tool-store.ts";
import { getLegacySessionToolNames } from "./legacy-session-tools.ts";

/** Desktop settings take priority; shared JSONL is read only for one-way legacy migration. */
export function loadSessionToolSelection(
  manager: Pick<SessionManager, "getSessionId" | "getEntries">,
  isNew: boolean,
  requested?: string[],
) {
  const store = getDefaultStore(),
    id = manager.getSessionId(),
    saved = store.get(id);
  const names = saved ?? getLegacySessionToolNames(manager) ?? requested;
  return {
    ...selectSessionShell({ isNew, storedShell: store.getShell(id), toolNames: names }),
    hasStoredTools: saved !== undefined,
  };
}

export function selectSessionShell({
  isNew,
  storedShell,
  toolNames,
  platform = process.platform,
  readDefault = () => agentShellPreferences().get().shell,
}: {
  isNew: boolean;
  storedShell?: AgentShell;
  toolNames?: string[];
  platform?: string;
  readDefault?: () => AgentShell;
}): { shell?: AgentShell; toolNames?: string[] } {
  // Restoring legacy sessions, including dual-shell grants, must not adopt a
  // later global preference. No-tools sessions still remember their executor.
  const shell = platform === "win32" ? (storedShell ?? (isNew ? readDefault() : undefined)) : undefined;
  const names = toolNames ?? (shell ? PRESET_DEFAULT : undefined);
  return { shell, toolNames: names === undefined ? undefined : useAgentShell(names, shell) };
}
