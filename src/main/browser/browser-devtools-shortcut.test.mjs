import assert from "node:assert/strict";
import test from "node:test";

import { isBrowserDevToolsShortcut } from "./browser-devtools-shortcut.ts";

function input(key, modifiers = {}) {
  return { key, control: false, meta: false, shift: false, alt: false, ...modifiers };
}

test("all supported DevTools shortcuts are blocked", () => {
  const shortcuts = [
    input("F12"),
    ...["i", "j", "c"].flatMap((key) => [
      input(key, { control: true, shift: true }),
      input(key.toUpperCase(), { meta: true, shift: true }),
      input(key, { meta: true, alt: true }),
    ]),
  ];

  for (const shortcut of shortcuts) assert.equal(isBrowserDevToolsShortcut(shortcut), true);
});

test("nearby browser and editing shortcuts remain available", () => {
  const allowed = [
    input("i", { control: true }),
    input("j", { meta: true }),
    input("c", { control: true }),
    input("r", { control: true, shift: true }),
    input("i", { alt: true }),
    input("x", { meta: true, alt: true }),
  ];

  for (const shortcut of allowed) assert.equal(isBrowserDevToolsShortcut(shortcut), false);
});
