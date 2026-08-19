import type { DesktopUiStatePatch } from "../contract/desktop";
import { isChatAppearancePreferences } from "../shared/chat-appearance.ts";

const RENDERER_WRITABLE_UI_STATE_FIELDS = new Set(["backgroundMode", "chatAppearance"]);

export function validateDesktopUiStatePatch(value: unknown): DesktopUiStatePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid UI state patch");
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !RENDERER_WRITABLE_UI_STATE_FIELDS.has(key))) {
    throw new Error("Unsupported UI state field");
  }

  const validated: DesktopUiStatePatch = {};
  if ("backgroundMode" in patch) {
    if (typeof patch.backgroundMode !== "boolean") throw new Error("Background mode must be a boolean");
    validated.backgroundMode = patch.backgroundMode;
  }
  if ("chatAppearance" in patch) {
    if (!isChatAppearancePreferences(patch.chatAppearance)) throw new Error("Invalid chat appearance preferences");
    validated.chatAppearance = patch.chatAppearance;
  }
  return validated;
}
