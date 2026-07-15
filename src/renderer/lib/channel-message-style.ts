import type { UserMessage } from "@shared/types";

export type MessageSource = NonNullable<UserMessage["channelSource"]> | "local";

export const USER_BUBBLE_COLORS: Record<MessageSource, string> = {
  local: "#1c1a17",
  weixin: "#08783e",
  telegram: "#1677a8",
  feishu: "#c2410c",
};

export function getUserBubbleColor(source?: UserMessage["channelSource"]): string {
  return USER_BUBBLE_COLORS[source ?? "local"];
}
