export const CHAT_FONT_SIZES = ["small", "standard", "large", "extra-large"] as const;
export const CHAT_LAYOUTS = ["fixed", "wide"] as const;
export const CHAT_ASSISTANT_WIDTHS = ["comfortable", "full"] as const;

export type ChatFontSize = (typeof CHAT_FONT_SIZES)[number];
export type ChatLayout = (typeof CHAT_LAYOUTS)[number];
export type ChatAssistantWidth = (typeof CHAT_ASSISTANT_WIDTHS)[number];

export interface ChatAppearancePreferences {
  fontSize: ChatFontSize;
  layout: ChatLayout;
  /** Omitted in UI state saved before reply width was configurable. */
  assistantWidth?: ChatAssistantWidth;
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearancePreferences = Object.freeze({
  fontSize: "standard",
  layout: "fixed",
  assistantWidth: "comfortable",
});

export const CHAT_FONT_SCALE: Readonly<Record<ChatFontSize, number>> = Object.freeze({
  small: 0.9,
  standard: 1,
  large: 1.15,
  "extra-large": 1.3,
});

const CHAT_FONT_SIZE_SET = new Set<string>(CHAT_FONT_SIZES);
const CHAT_LAYOUT_SET = new Set<string>(CHAT_LAYOUTS);

export function isChatFontSize(value: unknown): value is ChatFontSize {
  return typeof value === "string" && CHAT_FONT_SIZE_SET.has(value);
}

export function isChatLayout(value: unknown): value is ChatLayout {
  return typeof value === "string" && CHAT_LAYOUT_SET.has(value);
}

export function isChatAssistantWidth(value: unknown): value is ChatAssistantWidth {
  return value === "comfortable" || value === "full";
}

export function isChatAppearancePreferences(value: unknown): value is ChatAppearancePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isChatFontSize(record.fontSize) &&
    isChatLayout(record.layout) &&
    (record.assistantWidth === undefined || isChatAssistantWidth(record.assistantWidth))
  );
}

export function normalizeChatAppearance(value: unknown): ChatAppearancePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CHAT_APPEARANCE };
  const record = value as Record<string, unknown>;
  return {
    fontSize: isChatFontSize(record.fontSize) ? record.fontSize : DEFAULT_CHAT_APPEARANCE.fontSize,
    layout:
      record.layout === "full" ? "wide" : isChatLayout(record.layout) ? record.layout : DEFAULT_CHAT_APPEARANCE.layout,
    assistantWidth: isChatAssistantWidth(record.assistantWidth) ? record.assistantWidth : "comfortable",
  };
}
