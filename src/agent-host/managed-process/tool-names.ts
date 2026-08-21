export const MANAGED_PROCESS_TOOL_NAMES = [
  "process_start",
  "process_list",
  "process_read",
  "process_wait",
  "process_write",
  "process_stop",
  "process_restart",
] as const;

const MANAGED_PROCESS_TOOL_NAME_SET = new Set<string>(MANAGED_PROCESS_TOOL_NAMES);

export function isManagedProcessToolName(name: string): boolean {
  return MANAGED_PROCESS_TOOL_NAME_SET.has(name);
}
