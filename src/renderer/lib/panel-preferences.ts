import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  loadRightPanelPreferredWidth,
  saveRightPanelPreferredWidth,
} from "@/lib/layout-preferences";
const BROWSER_PANEL_WIDTH_KEY = "pi-desktop.browser-panel-width";

export function initialRightPanelPreferredWidth(): number {
  try {
    return loadRightPanelPreferredWidth(window.localStorage);
  } catch {
    return RIGHT_PANEL_DEFAULT_WIDTH;
  }
}

export function persistRightPanelPreferredWidth(width: number, browser = false): void {
  try {
    if (browser) window.localStorage.setItem(BROWSER_PANEL_WIDTH_KEY, String(Math.round(width)));
    else saveRightPanelPreferredWidth(window.localStorage, width);
  } catch {
    // Storage can become unavailable after startup; keep the in-memory preference.
  }
}

export function loadBrowserPanelPreferredWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(BROWSER_PANEL_WIDTH_KEY));
    return Number.isFinite(value) && value >= RIGHT_PANEL_MIN_WIDTH ? value : 520;
  } catch {
    return 520;
  }
}
