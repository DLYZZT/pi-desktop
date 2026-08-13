import type { UserMessage } from "@shared/types";

export type MessageSource = NonNullable<UserMessage["channelSource"]> | "local";
export type MessageTheme = "light" | "dark";

export interface UserBubbleStyle {
  background: string;
  foreground: string;
}

const USER_BUBBLE_FOREGROUND = "#faf9f7";

export const USER_BUBBLE_COLORS: Record<MessageTheme, Record<MessageSource, string>> = {
  light: {
    local: "#1c1a17",
    weixin: "#08783e",
    telegram: "#1677a8",
    feishu: "#c2410c",
  },
  dark: {
    local: "#3f3a33",
    weixin: "#0f6840",
    telegram: "#176689",
    feishu: "#a13d13",
  },
};

export function getUserBubbleStyle(source: UserMessage["channelSource"] | undefined, isDark: boolean): UserBubbleStyle {
  return {
    background: USER_BUBBLE_COLORS[isDark ? "dark" : "light"][source ?? "local"],
    foreground: USER_BUBBLE_FOREGROUND,
  };
}
