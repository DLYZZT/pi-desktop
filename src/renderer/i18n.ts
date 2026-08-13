import { useCallback, useSyncExternalStore } from "react";
import { dictionaries } from "./i18n-dictionaries.ts";

export type AppLanguage = "en-US" | "zh-CN";

const LANGUAGE_STORAGE_KEY = "pi-desktop:language";
const listeners = new Set<() => void>();

function detectLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en-US";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "en-US" || saved === "zh-CN") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

let currentLanguage = detectLanguage();

function applyDocumentLanguage(language: AppLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

applyDocumentLanguage(currentLanguage);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppLanguage {
  return currentLanguage;
}

function getServerSnapshot(): AppLanguage {
  return "en-US";
}

export function setAppLanguage(language: AppLanguage): void {
  if (language === currentLanguage) return;
  currentLanguage = language;
  applyDocumentLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function translate(key: string, fallback: string): string {
  return dictionaries[currentLanguage][key] ?? fallback;
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const t = useCallback(
    (key: string, fallback: string) => {
      return dictionaries[language][key] ?? fallback;
    },
    [language],
  );
  return { language, setLanguage: setAppLanguage, t };
}
