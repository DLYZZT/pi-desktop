/** A deliberately small, versioned compatibility profile, not the full Pi TUI API. */
export const DESKTOP_CUSTOM_UI = Object.freeze({
  version: 1 as const,
  customTui: true,
  viewport: true,
  bracketedPaste: true,
  explicitClose: true,
  atomicEditorInsert: true,
  keybindings: false,
  nestedOverlays: false,
  mouseWheel: "sgr" as const,
});

export type DesktopCustomUiCapabilities = typeof DESKTOP_CUSTOM_UI;
export type CustomUiAction =
  { kind: "close" } | { kind: "resize"; columns: number; rows: number } | { kind: "paste"; text: string };
export type CustomUiInput = string | CustomUiAction;
export type CustomUiViewport = { columns: number; rows: number };

export const MAX_CUSTOM_UI_INPUT = 100_000;
export const DEFAULT_CUSTOM_UI_VIEWPORT: Readonly<CustomUiViewport> = Object.freeze({ columns: 118, rows: 30 });

export function isCustomUiAction(value: unknown): value is CustomUiAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  switch (action.kind) {
    case "close":
      return true;
    case "resize":
      return (
        typeof action.columns === "number" &&
        Number.isInteger(action.columns) &&
        action.columns >= 1 &&
        action.columns <= 1000 &&
        typeof action.rows === "number" &&
        Number.isInteger(action.rows) &&
        action.rows >= 1 &&
        action.rows <= 1000
      );
    case "paste":
      return typeof action.text === "string" && action.text.length <= MAX_CUSTOM_UI_INPUT;
    default:
      return false;
  }
}

/** Treat pasted text as data. Strip terminal control bytes, including embedded paste terminators. */
export function bracketedPaste(text: string): string {
  if (text.length > MAX_CUSTOM_UI_INPUT) throw new Error("Custom UI paste exceeds 100,000 characters");
  const safe = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return `\x1b[200~${safe}\x1b[201~`;
}

export function normalizeViewport(viewport: CustomUiViewport): CustomUiViewport {
  return { columns: Math.max(16, Math.min(240, viewport.columns)), rows: Math.max(8, Math.min(100, viewport.rows)) };
}

/** Width is resolved against the panel's measured available space, never process.stdout. */
export function customUiWidth(options: unknown, viewport: CustomUiViewport): number {
  const raw =
    options && typeof options === "object" ? (options as { overlayOptions?: unknown }).overlayOptions : undefined;
  const resolved = typeof raw === "function" ? raw(viewport.columns, viewport.rows) : raw;
  const overlay = resolved && typeof resolved === "object" ? (resolved as { width?: unknown; minWidth?: unknown }) : {};
  let width = 92;
  if (typeof overlay.width === "number" && Number.isFinite(overlay.width)) width = Math.round(overlay.width);
  if (typeof overlay.width === "string" && /^\d+(?:\.\d+)?%$/.test(overlay.width)) {
    width = Math.floor((viewport.columns * Math.min(100, Number.parseFloat(overlay.width))) / 100);
  }
  const minWidth =
    typeof overlay.minWidth === "number" && Number.isFinite(overlay.minWidth) ? Math.round(overlay.minWidth) : 16;
  return Math.max(1, Math.min(viewport.columns, Math.max(16, minWidth, width)));
}
