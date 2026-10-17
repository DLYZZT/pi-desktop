import { ORCHESTRATION_TOOL_NAMES } from "./orchestration-tools.ts";
import { isMcpManagedTool } from "./mcp-tool-policy.ts";
import { isAgentShell, type AgentShell } from "./agent-shell.ts";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  available?: boolean;
  executionAllowed?: boolean;
}

export type ToolPreset = "none" | "default" | "full" | "custom";
export type SelectableToolPreset = Exclude<ToolPreset, "custom">;

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const CODING_FULL_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];
export const PRESET_FULL: string[] = [...CODING_FULL_TOOLS, ...ORCHESTRATION_TOOL_NAMES];

const BUILTIN_TOOL_NAMES = new Set([...CODING_FULL_TOOLS, "powershell"]);

export function codingToolAvailability(
  platform: string,
  capabilities: Readonly<Record<string, unknown>>,
  shell?: AgentShell,
) {
  const required: Record<string, string> = {
    bash: "shell.bash",
    powershell: "shell.powershell",
    grep: "search.rg",
    find: "search.fd",
  };
  return [...CODING_FULL_TOOLS, ...(platform === "win32" ? ["powershell"] : [])].map((name) => ({
    name,
    available:
      (!shell || !isAgentShell(name) || name === shell) && (!required[name] || Boolean(capabilities[required[name]])),
  }));
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = getSelectedToolNames(tools);
  if (activeTools.length === 0) return "none";

  const active = activeTools
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (
    active === [...PRESET_DEFAULT].sort().join(",") ||
    active ===
      PRESET_DEFAULT.map((name) => (name === "bash" ? "powershell" : name))
        .sort()
        .join(",")
  )
    return "default";
  if (
    active ===
    getToolNamesForPreset("full", tools)
      .filter((name) => BUILTIN_TOOL_NAMES.has(name))
      .sort()
      .join(",")
  )
    return ORCHESTRATION_TOOL_NAMES.every(
      (name) => !tools.some((tool) => tool.name === name && !activeTools.includes(name)),
    )
      ? "full"
      : "custom";
  return "custom";
}

/** Declarations alone must not become a new execution grant when another checkbox is edited. */
export function getSelectedToolNames(tools: readonly ToolEntry[]): string[] {
  return tools
    .filter(
      (tool) =>
        tool.active &&
        tool.executionAllowed !== false &&
        (tool.executionAllowed === true || (tool.name !== "powershell" && !isMcpManagedTool(tool.name))),
    )
    .map((tool) => tool.name);
}

export function getToolNamesForPreset(
  preset: ToolPreset,
  tools?: readonly Pick<ToolEntry, "name" | "available">[],
): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full")
    return [
      ...PRESET_FULL,
      ...(tools?.some((tool) => tool.name === "powershell" && tool.available !== false) ? ["powershell"] : []),
    ].filter((name) => !tools?.some((tool) => tool.name === name && tool.available === false));
  const shell =
    tools?.some((tool) => tool.name === "bash" && tool.available === false) &&
    tools.some((tool) => tool.name === "powershell" && tool.available !== false)
      ? "powershell"
      : "bash";
  return PRESET_DEFAULT.map((name) => (name === "bash" ? shell : name));
}
