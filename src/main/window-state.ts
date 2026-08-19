import { app, type BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import type { DesktopUiState } from "../contract/desktop";
import { normalizeChatAppearance } from "../shared/chat-appearance.ts";
import { persistableWindowState, resolveWindowBounds, type DisplayBounds } from "./window-state-core";

export type UiState = DesktopUiState & {
  window?: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    isMaximized?: boolean;
  };
  sidebarWidth?: number;
  theme?: "light" | "dark" | "system";
  recentCwds?: string[];
  backgroundMode?: boolean;
  automaticUpdateChecks?: boolean;
};

function statePath(): string {
  return path.join(app.getPath("userData"), "ui-state.json");
}

export function loadUiState(): UiState {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state = parsed as UiState;
    if ("chatAppearance" in state) state.chatAppearance = normalizeChatAppearance(state.chatAppearance);
    return state;
  } catch {
    return {};
  }
}

export function saveUiState(patch: Partial<UiState>): void {
  try {
    saveUiStateStrict(patch);
  } catch {
    /* best-effort lifecycle persistence */
  }
}

export function saveUiStateStrict(patch: Partial<UiState>): void {
  const current = loadUiState();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
}

export function trackWindowState(win: BrowserWindow): void {
  const persist = () => {
    const window = persistableWindowState(win);
    if (window) saveUiState({ window });
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("close", persist);
}

export function applyWindowBounds(
  defaults: { x?: number; y?: number; width: number; height: number },
  state: UiState,
  displays?: DisplayBounds,
): { x?: number; y?: number; width: number; height: number } {
  return resolveWindowBounds(defaults, state.window, displays);
}

export function shouldMaximize(state: UiState): boolean {
  return Boolean(state.window?.isMaximized);
}
