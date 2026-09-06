import { useCallback, useSyncExternalStore } from "react";
import { dictionaries } from "./i18n-dictionaries.ts";

export type AppLanguage = "en-US" | "zh-CN" | "zh-TW";

const LANGUAGE_STORAGE_KEY = "pi-desktop:language";
const listeners = new Set<() => void>();

function detectLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en-US";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "en-US" || saved === "zh-CN" || saved === "zh-TW") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  const browserLanguage = window.navigator.language.toLowerCase();
  if (!browserLanguage.startsWith("zh")) return "en-US";
  return /(?:hant|tw|hk|mo)/.test(browserLanguage) ? "zh-TW" : "zh-CN";
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

function lookup(language: AppLanguage, key: string, fallback: string): string {
  const value =
    dictionaries[language][key] ?? (language === "zh-TW" ? dictionaries["zh-CN"][key] : undefined);
  return value ?? fallback;
}

export function translate(key: string, fallback: string): string {
  return lookup(currentLanguage, key, fallback);
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const t = useCallback(
    (key: string, fallback: string) => {
      return lookup(language, key, fallback);
    },
    [language],
  );
  return { language, setLanguage: setAppLanguage, t };
}
