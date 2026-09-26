import type { WebContents, WebFrameMain } from "electron";
import type { BrowserInputModifier } from "../../contract/browser.ts";
import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { SNAPSHOT_WORLD_ID, elementPointScript } from "./browser-dom-scripts.ts";
import { abortableDelay } from "./browser-action-timing.ts";
import { clampInteger } from "./browser-bounds.ts";

const KEY_PATTERN =
  /^(Enter|Tab|Escape|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down)|F[1-9]|F1[0-2]|[A-Za-z0-9])$/;

// The tab owner supplies the input scope and action cancellation. This module
// sends input through the existing WebContents/CDP pair without owning tab state.
export interface BrowserInputTarget {
  contents: Pick<WebContents, "focus" | "sendInputEvent" | "executeJavaScriptInIsolatedWorld">;
  tabId: string;
  cdp: Pick<BrowserCdpCoordinator, "acquire" | "sendCommand">;
  humanized: () => boolean;
  withSyntheticInput: <T>(task: () => Promise<T>) => Promise<T>;
}

export function validateBrowserText(text: string): void {
  if (typeof text !== "string" || text.length > 64 * 1024 || /\0/.test(text)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser text input is invalid");
  }
}
export function validateBrowserKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser key is not allowed");
  }
}

export async function typeBrowserText(
  target: BrowserInputTarget,
  frameContext: { frame: Pick<WebFrameMain, "executeJavaScript">; offsetX: number; offsetY: number },
  snapshotId: string,
  ref: string,
  text: string,
  submit: boolean,
  signal: AbortSignal,
): Promise<"key-events" | "mixed-insert-text"> {
  const point = await frameContext.frame.executeJavaScript(elementPointScript(snapshotId, ref, true));
  if (!isPoint(point)) throw new BrowserError("STALE_ELEMENT_REF", "Browser element is no longer editable");
  point.x += frameContext.offsetX;
  point.y += frameContext.offsetY;
  return target.withSyntheticInput(async () => {
    const releaseInputFocus = target.cdp.acquire(target.tabId);
    let focusEmulationEnabled = false;
    let usedInsertText = false;
    try {
      await target.cdp.sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      focusEmulationEnabled = true;
      target.contents.focus();
      await sendBrowserMouseClick(target, point.x, point.y, "left", 1, signal, [], true);
      // Keep the renderer focused for the complete input sequence. A hidden
      // Electron view may not have native window focus under Linux/Xvfb, so
      // do not restore focus emulation between the click and text insertion.
      // Re-focus the exact frame element after the trusted click so CDP text
      // insertion also reaches out-of-process iframes deterministically.
      const focusedPoint = await frameContext.frame.executeJavaScript(elementPointScript(snapshotId, ref, true));
      if (!isPoint(focusedPoint)) {
        throw new BrowserError("STALE_ELEMENT_REF", "Browser element is no longer editable");
      }
      target.contents.focus();
      const selectModifier: BrowserInputModifier = process.platform === "darwin" ? "meta" : "control";
      const selectModifiers = cdpModifierMask([selectModifier]);
      await target.cdp.sendCommand(target.tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: selectModifiers,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
      });
      await target.cdp.sendCommand(target.tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: selectModifiers,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
      });
      // Keep selection and character events ordered on the same CDP queue,
      // then round-trip through the target OOPIF before inserting text.
      await frameContext.frame.executeJavaScript("true");
      for (const character of [...text]) {
        if (signal.aborted) throw new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
        if (/^[\x20-\x7e]$/.test(character)) {
          target.contents.sendInputEvent({ type: "keyDown", keyCode: character });
          target.contents.sendInputEvent({ type: "char", keyCode: character });
          target.contents.sendInputEvent({ type: "keyUp", keyCode: character });
        } else {
          await target.cdp.sendCommand(target.tabId, "Input.dispatchKeyEvent", {
            type: "char",
            key: character,
            text: character,
            unmodifiedText: character,
          });
          usedInsertText = true;
        }
        if (target.humanized()) await abortableDelay(randomBetween(18, 64), signal);
      }
      if (submit) {
        target.contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        target.contents.sendInputEvent({ type: "char", keyCode: "Enter" });
        if (target.humanized()) await abortableDelay(randomBetween(28, 85), signal);
        target.contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      }
      return usedInsertText ? "mixed-insert-text" : "key-events";
    } finally {
      if (focusEmulationEnabled) {
        await target.cdp
          .sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false })
          .catch(() => undefined);
      }
      releaseInputFocus();
    }
  });
}

export async function pressBrowserKey(
  target: BrowserInputTarget,
  key: string,
  modifiers: BrowserInputModifier[],
): Promise<void> {
  await target.withSyntheticInput(async () => {
    target.contents.focus();
    target.contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
    if (key.length === 1 && !modifiers.some((modifier) => modifier !== "shift")) {
      target.contents.sendInputEvent({ type: "char", keyCode: key, modifiers });
    }
    target.contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  });
}

export async function scrollBrowserPage(
  target: BrowserInputTarget,
  input: { x?: number; y?: number },
  deltaX: number,
  deltaY: number,
  signal: AbortSignal,
): Promise<void> {
  const viewport = (await target.contents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
    { code: `({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })` },
  ])) as { width?: unknown; height?: unknown };
  const x = clampInteger(input.x ?? Number(viewport.width) / 2, 0, Math.max(0, Number(viewport.width) - 1));
  const y = clampInteger(input.y ?? Number(viewport.height) / 2, 0, Math.max(0, Number(viewport.height) - 1));
  const segments = target.humanized() ? clampInteger(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 180, 2, 12) : 1;
  const releaseScrollFocus = target.cdp.acquire(target.tabId);
  let focusEmulationEnabled = false;
  try {
    await target.cdp.sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulationEnabled = true;
    await target.withSyntheticInput(async () => {
      target.contents.focus();
      for (let index = 0; index < segments; index += 1) {
        target.contents.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: Math.round(deltaX / segments),
          deltaY: Math.round(deltaY / segments),
          canScroll: true,
        });
        if (segments > 1) await abortableDelay(randomBetween(12, 38), signal);
      }
      await abortableDelay(32, signal);
    });
  } finally {
    if (focusEmulationEnabled) {
      await target.cdp
        .sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false })
        .catch(() => undefined);
    }
    releaseScrollFocus();
  }
}

export async function sendBrowserMouseClick(
  target: BrowserInputTarget,
  x: number,
  y: number,
  button: "left" | "middle" | "right",
  clickCount: 1 | 2,
  signal: AbortSignal,
  modifiers: BrowserInputModifier[] = [],
  preserveFocusEmulation = false,
): Promise<void> {
  target.contents.focus();
  const releaseDebugger = target.cdp.acquire(target.tabId);
  const cdpModifiers = cdpModifierMask(modifiers);
  let focusEmulationEnabled = false;
  try {
    await target.cdp.sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulationEnabled = true;
    if (target.humanized()) {
      const viewport = (await target.contents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
        { code: `({ x: Math.max(0, innerWidth / 2), y: Math.max(0, innerHeight / 2) })` },
      ])) as { x?: unknown; y?: unknown };
      const startX = Number(viewport.x) || x;
      const startY = Number(viewport.y) || y;
      const segments = randomBetween(3, 7);
      for (let index = 1; index <= segments; index += 1) {
        const progress = index / segments;
        await target.cdp.sendCommand(target.tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(startX + (x - startX) * progress),
          y: Math.round(startY + (y - startY) * progress),
          modifiers: cdpModifiers,
        });
        await abortableDelay(randomBetween(8, 24), signal);
      }
    } else {
      await target.cdp.sendCommand(target.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        modifiers: cdpModifiers,
      });
    }
    await target.cdp.sendCommand(target.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: cdpButtonMask(button),
      clickCount,
      modifiers: cdpModifiers,
    });
    if (target.humanized()) await abortableDelay(randomBetween(35, 105), signal);
    await target.cdp.sendCommand(target.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount,
      modifiers: cdpModifiers,
    });
    // A CDP command acknowledgement only confirms that Chromium accepted the
    // input. Queue a no-op in the isolated world so non-navigation handlers
    // have run before the click result is returned to the next Agent tool.
    await target.contents
      .executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [{ code: "true" }])
      .catch(() => undefined);
    await abortableDelay(32, signal);
  } finally {
    if (focusEmulationEnabled && !preserveFocusEmulation) {
      await target.cdp
        .sendCommand(target.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false })
        .catch(() => undefined);
    }
    releaseDebugger();
  }
}

export function isPoint(value: unknown): value is { x: number; y: number; externalUrl?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite((value as { x?: unknown }).x) &&
    Number.isFinite((value as { y?: unknown }).y)
  );
}

function randomBetween(minimum: number, maximum: number): number {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
}

export function validateInputModifiers(value: BrowserInputModifier[]): BrowserInputModifier[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser input modifiers are invalid");
  }
  const allowed = new Set<BrowserInputModifier>(["alt", "control", "meta", "shift"]);
  const result = [...new Set(value)];
  if (result.some((modifier) => !allowed.has(modifier))) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser input modifiers are invalid");
  }
  return result;
}

function cdpModifierMask(modifiers: BrowserInputModifier[]): number {
  return modifiers.reduce((mask, modifier) => {
    if (modifier === "alt") return mask | 1;
    if (modifier === "control") return mask | 2;
    if (modifier === "meta") return mask | 4;
    return mask | 8;
  }, 0);
}

function cdpButtonMask(button: "left" | "middle" | "right"): number {
  if (button === "left") return 1;
  if (button === "right") return 2;
  return 4;
}
