export interface BrowserShortcutInput {
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

const DEVTOOLS_KEYS = new Set(["i", "j", "c"]);

export function isBrowserDevToolsShortcut(input: BrowserShortcutInput): boolean {
  if (input.key.toLowerCase() === "f12") return true;
  const key = input.key.toLowerCase();
  if (!DEVTOOLS_KEYS.has(key)) return false;
  const primaryModifier = input.control || input.meta;
  return primaryModifier && (input.shift || (input.meta && input.alt));
}
