export interface CustomUiKeyboardEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  getModifierState?(key: "AltGraph"): boolean;
}

/** Printable text is handled by textarea input events, including composed/non-Latin text. */
export function customUiKey(event: CustomUiKeyboardEvent): string | null {
  if (event.isComposing || event.key === "Process" || event.key === "Dead" || event.getModifierState?.("AltGraph"))
    return null;
  // Keep platform copy/paste and other Command shortcuts native; onPaste handles the text.
  if (event.metaKey) return null;
  if (event.ctrlKey && !event.altKey && event.key.length === 1) {
    const key = event.key.toLowerCase();
    if (key >= "a" && key <= "z") return String.fromCharCode(key.charCodeAt(0) - 96);
    if (key === " ") return "\x00";
  }
  const modifier = 1 + Number(event.shiftKey) + 2 * Number(event.altKey) + 4 * Number(event.ctrlKey);
  const arrows: Readonly<Record<string, string>> = {
    ArrowUp: "A",
    ArrowDown: "B",
    ArrowRight: "C",
    ArrowLeft: "D",
    Home: "H",
    End: "F",
  };
  if (arrows[event.key]) return modifier === 1 ? `\x1b[${arrows[event.key]}` : `\x1b[1;${modifier}${arrows[event.key]}`;
  const tilde: Readonly<Record<string, number>> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };
  if (tilde[event.key]) return modifier === 1 ? `\x1b[${tilde[event.key]}~` : `\x1b[${tilde[event.key]};${modifier}~`;
  switch (event.key) {
    case "Enter":
      return modifier === 1 ? "\r" : `\x1b[13;${modifier}u`;
    case "Escape":
      return "\x1b";
    case "Backspace":
      return event.altKey ? "\x1b\x7f" : event.ctrlKey ? "\x08" : "\x7f";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    default:
      return null;
  }
}

export function customUiWheel(deltaY: number): string | null {
  return !Number.isFinite(deltaY) || deltaY === 0 ? null : `\x1b[<${deltaY < 0 ? 64 : 65};1;1M`;
}

/** Used by ownership hooks: close the exact old request, never the currently selected session. */
export function closeCustomUiOnAbort(signal: AbortSignal, close: () => void): () => void {
  let active = true;
  const abort = () => {
    if (active) {
      active = false;
      close();
    }
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => {
    active = false;
    signal.removeEventListener("abort", abort);
  };
}
