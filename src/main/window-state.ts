import { app, type BrowserWindow, type Rectangle } from "electron";
import fs from "fs";
import path from "path";

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
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    saveUiState({
      window: {
        ...bounds,
        isMaximized: win.isMaximized(),
      },
    });
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

export function applyWindowBounds(defaults: Rectangle, state: UiState): Rectangle {
  const w = state.window;
  if (!w) return defaults;
  return {
    x: w.x ?? defaults.x,
    y: w.y ?? defaults.y,
    width: Math.max(900, w.width || defaults.width),
    height: Math.max(600, w.height || defaults.height),
  };
}
