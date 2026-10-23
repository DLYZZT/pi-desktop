import type { AgentSessionLike } from "../shared/pi-types";
import { filterDesktopToolNames } from "../shared/pi-tool-policy";
import { isBrowserToolName } from "./browser-tools";

export const CODING_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export function filterUnapprovedShellTools(names: string[], requested?: string[]): string[] {
  return filterDesktopToolNames(
    names.filter((name) => name !== "powershell" || requested?.includes(name)),
    process.platform,
  );
}

/** Only default declarable extensions join a Desktop coding preset. */
export function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];
  const extensionNames = session
    .getAllTools()
    .filter((tool) => {
      const exposure = tool.exposure ?? "direct";
      return (
        !CODING_TOOL_NAMES.has(tool.name) &&
        !isBrowserToolName(tool.name) &&
        (exposure === "direct" || exposure === "model-only") &&
        session.getToolDefinition?.(tool.name)?.defaultActive !== false
      );
    })
    .map((tool) => tool.name);
  return filterDesktopToolNames([...toolNames, ...extensionNames], process.platform);
}

/**
 * Keep the current active set but drop names the SDK restored from the branch and has not registered yet.
 * setActiveToolsByName keeps those pending names unless a call deactivates a tool, so they would otherwise
 * activate on registration (for example a connecting MCP server) outside the Desktop selection.
 */
export function dropPendingRestoredTools(session: AgentSessionLike): void {
  const active = session.getActiveToolNames();
  if (active.length === 0) return;
  session.setActiveToolsByName([]);
  session.setActiveToolsByName(active);
}
