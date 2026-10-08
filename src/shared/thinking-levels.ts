export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelOption = "auto" | ThinkingLevel;
const THINKING_SUFFIXES = new Set<string>(THINKING_LEVELS);

export function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colon = trimmed.lastIndexOf(":");
  return colon >= 0 && THINKING_SUFFIXES.has(trimmed.slice(colon + 1)) ? trimmed.slice(0, colon) : trimmed;
}

export function thinkingMenuLevels(available?: readonly string[] | null): ThinkingLevelOption[] {
  return ["auto", ...THINKING_LEVELS.filter((level) => (available ? available.includes(level) : level !== "max"))];
}
