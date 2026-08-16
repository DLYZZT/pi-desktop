import { importTestBundle } from "#test-bundle";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { AUTO_TITLE_STORAGE_KEY, isAutoSessionTitleEnabled, setAutoSessionTitleEnabled, shouldAutoTitleMessage } =
  await importTestBundle("src/renderer/lib/auto-session-title", {
    entryPoints: [path.join(import.meta.dirname, "auto-session-title.ts")],
  });

function createFakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

beforeEach(() => {
  globalThis.window = { localStorage: createFakeStorage() };
});

test("auto titles are enabled by default", () => {
  assert.equal(isAutoSessionTitleEnabled(), true);
});

test("setting persistence round-trips through localStorage", () => {
  setAutoSessionTitleEnabled(false);
  assert.equal(isAutoSessionTitleEnabled(), false);
  assert.equal(globalThis.window.localStorage.getItem(AUTO_TITLE_STORAGE_KEY), "off");

  setAutoSessionTitleEnabled(true);
  assert.equal(isAutoSessionTitleEnabled(), true);
  assert.equal(globalThis.window.localStorage.getItem(AUTO_TITLE_STORAGE_KEY), null);
});

test("a real first message qualifies", () => {
  assert.equal(shouldAutoTitleMessage("修复登录页的样式问题", false), true);
  assert.equal(shouldAutoTitleMessage("Fix the login page", false), true);
});

test("slash commands never qualify", () => {
  assert.equal(shouldAutoTitleMessage("/init", false), false);
  assert.equal(shouldAutoTitleMessage("/model gpt-4o", false), false);
});

test("text-only messages shorter than two characters never qualify", () => {
  assert.equal(shouldAutoTitleMessage("a", false), false);
  assert.equal(shouldAutoTitleMessage("  ", false), false);
});

test("an image-only message qualifies even when its text is minimal", () => {
  assert.equal(shouldAutoTitleMessage("a", true), true);
  assert.equal(shouldAutoTitleMessage("", true), false);
});

test("qualification respects the settings toggle", () => {
  setAutoSessionTitleEnabled(false);
  assert.equal(shouldAutoTitleMessage("Fix the login page", false), false);
  setAutoSessionTitleEnabled(true);
  assert.equal(shouldAutoTitleMessage("Fix the login page", false), true);
});

test("missing window (non-renderer context) keeps the default enabled state", () => {
  delete globalThis.window;
  assert.equal(isAutoSessionTitleEnabled(), true);
});

test("unknown localStorage values keep auto titles enabled", () => {
  globalThis.window.localStorage.setItem(AUTO_TITLE_STORAGE_KEY, "yes");
  assert.equal(isAutoSessionTitleEnabled(), true);
});
