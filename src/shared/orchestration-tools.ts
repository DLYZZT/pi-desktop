export const ORCHESTRATION_TOOL_NAMES = ["codemode", "tool_search"] as const;

export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.some((entry) => entry === name);
}
