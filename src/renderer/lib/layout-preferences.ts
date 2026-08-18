export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-desktop:right-panel-width:v2";
export const RIGHT_PANEL_MIN_WIDTH = 280;
export const RIGHT_PANEL_DEFAULT_WIDTH = 360;
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.4;
export const CHAT_MIN_WIDTH = 420;
export const SIDEBAR_WIDTH = 280;

const RIGHT_PANEL_KEYBOARD_STEP = 16;
const RIGHT_PANEL_KEYBOARD_LARGE_STEP = 48;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RightPanelWidthBounds {
  minWidth: number;
  maxWidth: number;
}

export type RightPanelResizeKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function loadRightPanelPreferredWidth(storage?: StorageLike | null): number {
  try {
    const stored = Number(storage?.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= RIGHT_PANEL_MIN_WIDTH) return Math.round(stored);
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return RIGHT_PANEL_DEFAULT_WIDTH;
}

export function saveRightPanelPreferredWidth(storage: StorageLike | null | undefined, width: number): void {
  if (!Number.isFinite(width)) return;
  try {
    storage?.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width))));
  } catch {
    // Resizing remains useful for the current session even when persistence fails.
  }
}

export function getRightPanelWidthBounds(viewportWidth: number, sidebarOpen: boolean): RightPanelWidthBounds {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return { minWidth: RIGHT_PANEL_MIN_WIDTH, maxWidth: RIGHT_PANEL_DEFAULT_WIDTH };
  }

  const ratioLimit = Math.floor(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO);
  const reservedWidth = CHAT_MIN_WIDTH + (sidebarOpen ? SIDEBAR_WIDTH : 0);
  const availableLimit = Math.floor(viewportWidth - reservedWidth);
  const maxWidth = Math.max(0, Math.min(ratioLimit, availableLimit));

  return {
    minWidth: Math.min(RIGHT_PANEL_MIN_WIDTH, maxWidth),
    maxWidth,
  };
}

export function clampRightPanelWidth(width: number, viewportWidth: number, sidebarOpen: boolean): number {
  const { minWidth, maxWidth } = getRightPanelWidthBounds(viewportWidth, sidebarOpen);
  if (maxWidth <= 0) return 0;
  const candidate = Number.isFinite(width) ? width : RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(maxWidth, Math.max(minWidth, candidate)));
}

export function shouldCollapseSidebarForRightPanel(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth)) return false;
  return viewportWidth < SIDEBAR_WIDTH + CHAT_MIN_WIDTH + RIGHT_PANEL_MIN_WIDTH;
}

export function getKeyboardAdjustedRightPanelWidth(
  currentWidth: number,
  key: RightPanelResizeKey,
  viewportWidth: number,
  sidebarOpen: boolean,
  largeStep = false,
): number {
  const bounds = getRightPanelWidthBounds(viewportWidth, sidebarOpen);
  const step = largeStep ? RIGHT_PANEL_KEYBOARD_LARGE_STEP : RIGHT_PANEL_KEYBOARD_STEP;

  if (key === "Home") return bounds.minWidth;
  if (key === "End") return bounds.maxWidth;

  // The separator is on the panel's left edge: moving left grows the panel.
  const nextWidth = key === "ArrowLeft" ? currentWidth + step : currentWidth - step;
  return clampRightPanelWidth(nextWidth, viewportWidth, sidebarOpen);
}

/* ── Codex-style sidebar: workspace folders, pinned items, project expand state ── */

export const WORKSPACE_FOLDERS_STORAGE_KEY = "pi-desktop:workspace-folders:v1";
export const PINNED_ITEMS_STORAGE_KEY = "pi-desktop:pinned-items:v1";
export const PROJECTS_EXPANDED_STORAGE_KEY = "pi-desktop:projects-expanded:v1";
export const PINNED_SECTION_OPEN_STORAGE_KEY = "pi-desktop:pinned-section-open:v1";
export const RECENT_SECTION_OPEN_STORAGE_KEY = "pi-desktop:recent-section-open:v1";

export interface PinnedItem {
  type: "session" | "project";
  id: string;
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadWorkspaceFolders(storage?: StorageLike | null): string[] {
  const raw = safeParse(storage?.getItem(WORKSPACE_FOLDERS_STORAGE_KEY) ?? null);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function saveWorkspaceFolders(storage: StorageLike | null | undefined, folders: string[]): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_FOLDERS_STORAGE_KEY, JSON.stringify(folders));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

export function loadPinnedItems(storage?: StorageLike | null): PinnedItem[] {
  const raw = safeParse(storage?.getItem(PINNED_ITEMS_STORAGE_KEY) ?? null);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is PinnedItem =>
      !!item &&
      typeof item === "object" &&
      (item.type === "session" || item.type === "project") &&
      typeof item.id === "string",
  );
}

export function savePinnedItems(storage: StorageLike | null | undefined, items: PinnedItem[]): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_ITEMS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

export function loadExpandedProjects(storage?: StorageLike | null): string[] {
  const raw = safeParse(storage?.getItem(PROJECTS_EXPANDED_STORAGE_KEY) ?? null);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function saveExpandedProjects(storage: StorageLike | null | undefined, projects: string[]): void {
  if (!storage) return;
  try {
    storage.setItem(PROJECTS_EXPANDED_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

export function loadSectionOpen(storage?: StorageLike | null, key?: string): boolean {
  if (!storage || !key) return false;
  return storage.getItem(key) === "1";
}

export function saveSectionOpen(storage: StorageLike | null | undefined, key: string | undefined, open: boolean): void {
  if (!storage || !key) return;
  try {
    storage.setItem(key, open ? "1" : "0");
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
