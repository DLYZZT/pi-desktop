export const noticeKeys = ["cacheMisses", "cacheWarming", "compactionCosts", "reasoningDrops"] as const;
export type NoticeKey = (typeof noticeKeys)[number];
export type NoticePreferences = Record<NoticeKey, boolean>;
export interface NoticeSettingsStatus {
  /** Global preferences remain usable if the trusted project file cannot be parsed. */
  projectLoadFailed?: true;
  global: NoticePreferences;
  project: Partial<NoticePreferences>;
  effective: NoticePreferences;
}
export type TranscriptNotice =
  | { kind: "cacheMisses"; tokens: number }
  | { kind: "cacheWarming" | "compactionCosts"; tokens: number; cost: number; branchSummary?: boolean }
  | { kind: "reasoningDrops"; provider: "OpenAI" | "Anthropic"; count: number; reasons: string[] };
