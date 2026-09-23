import { useCallback, useSyncExternalStore } from "react";
import { dictionaries } from "./i18n-dictionaries.ts";
import { resolveAppLanguage, type AppLanguage } from "../shared/app-language.ts";
export type { AppLanguage } from "../shared/app-language.ts";

const LANGUAGE_STORAGE_KEY = "pi-desktop:language";
const listeners = new Set<() => void>();

function detectLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en-US";
  let saved: unknown;
  try {
    saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return resolveAppLanguage(saved, window.navigator.language);
}

let currentLanguage = detectLanguage();

function applyDocumentLanguage(language: AppLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

function syncNativeLanguage(language: AppLanguage): void {
  if (typeof window === "undefined" || !window.piBridge?.setUiState) return;
  void window.piBridge.setUiState({ language }).catch((error: unknown) => {
    console.warn("Unable to sync native UI language", error);
  });
}

applyDocumentLanguage(currentLanguage);
syncNativeLanguage(currentLanguage);

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
  syncNativeLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  listeners.forEach((listener) => listener());
}

function lookup(language: AppLanguage, key: string, fallback: string): string {
  const value = dictionaries[language][key] ?? (language === "zh-TW" ? dictionaries["zh-CN"][key] : undefined);
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
