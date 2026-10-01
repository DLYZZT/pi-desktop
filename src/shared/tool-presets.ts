import { ORCHESTRATION_TOOL_NAMES } from "./orchestration-tools.ts";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full" | "custom";
export type SelectableToolPreset = Exclude<ToolPreset, "custom">;

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const CODING_FULL_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];
export const PRESET_FULL: string[] = [...CODING_FULL_TOOLS, ...ORCHESTRATION_TOOL_NAMES];

const BUILTIN_TOOL_NAMES = new Set(CODING_FULL_TOOLS);

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";

  const active = activeTools
    .map((t) => t.name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...CODING_FULL_TOOLS].sort().join(","))
    return ORCHESTRATION_TOOL_NAMES.every((name) => !tools.some((tool) => tool.name === name && !tool.active))
      ? "full"
      : "custom";
  return "custom";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}
