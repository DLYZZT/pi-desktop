import { app, type BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import { persistableWindowState, resolveWindowBounds, type DisplayBounds } from "./window-state-core";

export type UiState = {
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
    return JSON.parse(raw) as UiState;
  } catch {
    return {};
  }
}

export function saveUiState(patch: Partial<UiState>): void {
  const current = loadUiState();
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  } catch {
    /* ignore */
  }
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
