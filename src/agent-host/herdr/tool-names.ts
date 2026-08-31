export const HERDR_TOOL_NAMES = [
  "herdr_status",
  "herdr_list",
  "herdr_workspace_create",
  "herdr_tab_create",
  "herdr_tab_focus",
  "herdr_tab_rename",
  "herdr_pane_split",
  "herdr_pane_read",
  "herdr_agent_start",
  "herdr_agent_prompt",
  "herdr_agent_wait",
  "herdr_agent_keys",
] as const;

const HERDR_TOOL_NAME_SET = new Set<string>(HERDR_TOOL_NAMES);

export function isHerdrToolName(name: string): boolean {
  return HERDR_TOOL_NAME_SET.has(name);
}
