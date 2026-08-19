import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatAppearancePreferences } from "@shared/chat-appearance";
import { applyChatAppearance, ChatAppearanceController } from "@/lib/chat-appearance";

export function useChatAppearance(): {
  preferences: ChatAppearancePreferences;
  loaded: boolean;
  saving: boolean;
  update: (preferences: ChatAppearancePreferences) => Promise<void>;
} {
  const controllerRef = useRef<ChatAppearanceController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ChatAppearanceController({
      read: async () => (await window.piBridge.getUiState()).chatAppearance,
      write: (preferences) => window.piBridge.setUiState({ chatAppearance: preferences }),
      apply: (preferences) => applyChatAppearance(document.documentElement, preferences),
    });
  }
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    void controller.load();
  }, [controller]);

  return { ...snapshot, update: (preferences) => controller.update(preferences) };
}
