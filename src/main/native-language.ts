import { app } from "electron";
import { resolveAppLanguage } from "../shared/app-language.ts";
import { loadUiState } from "./window-state";

export function getNativeLanguage() {
  return resolveAppLanguage(loadUiState().language, app.getLocale());
}
