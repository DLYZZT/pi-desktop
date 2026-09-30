import type { AgentSessionLike } from "../shared/pi-types";
import { filterDesktopToolNames } from "../shared/pi-tool-policy";
import { isBrowserToolName } from "./browser-tools";

export const CODING_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

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
  return filterDesktopToolNames([...toolNames, ...extensionNames]);
}
