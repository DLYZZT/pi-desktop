import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const appliedAtImport = [];
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

globalThis.document = {
  documentElement: {
    classList: { toggle: (name, enabled) => appliedAtImport.push(["class", name, enabled]) },
    style: {},
  },
};
globalThis.localStorage = { getItem: () => null };
globalThis.window = { matchMedia: () => ({ matches: true }) };

const { initializeTheme, resolveInitialTheme } = await importTestBundle("src/renderer/theme-init", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "theme-init.ts")],
});

globalThis.document = originalDocument;
globalThis.localStorage = originalLocalStorage;
globalThis.window = originalWindow;

test("module applies system dark mode synchronously before React mounts", () => {
  assert.deepEqual(appliedAtImport, [["class", "dark", true]]);
});

test("explicit persisted themes override the system and invalid values follow it", () => {
  assert.equal(resolveInitialTheme("light", true), "light");
  assert.equal(resolveInitialTheme("dark", false), "dark");
  assert.equal(resolveInitialTheme("system", true), "dark");
  assert.equal(resolveInitialTheme(null, false), "light");
});

test("initializer tolerates storage and media-query failures and always applies a theme", () => {
  const applied = [];
  const theme = initializeTheme({
    readStoredTheme: () => {
      throw new Error("storage blocked");
    },
    systemPrefersDark: () => {
      throw new Error("media query blocked");
    },
    applyTheme: (value) => applied.push(value),
  });
  assert.equal(theme, "light");
  assert.deepEqual(applied, ["light"]);
});

test("theme initialization precedes React and all theme transitions synchronize color-scheme", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf("./theme-init.ts") < html.indexOf("./main.tsx"));

  const initSource = readFileSync(new URL("./theme-init.ts", import.meta.url), "utf8");
  const hookSource = readFileSync(new URL("./hooks/useTheme.ts", import.meta.url), "utf8");
  assert.match(initSource, /document\.documentElement\.style\.colorScheme = theme/);
  assert.match(hookSource, /document\.documentElement\.style\.colorScheme = theme/);
  assert.match(hookSource, /applyDocumentTheme\(dark \? "dark" : "light"\)/);
  assert.match(hookSource, /applyDocumentTheme\(next\)/);
});
