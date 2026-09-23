import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopUiStatePatch } from "./ui-state-patch.ts";

test("renderer UI state accepts only complete, known appearance preferences", () => {
  assert.deepEqual(
    validateDesktopUiStatePatch({
      backgroundMode: false,
      managedProcessesEnabled: true,
      chatAppearance: { fontSize: "extra-large", layout: "wide" },
    }),
    {
      backgroundMode: false,
      managedProcessesEnabled: true,
      chatAppearance: { fontSize: "extra-large", layout: "wide" },
    },
  );

  for (const assistantWidth of ["comfortable", "full"]) {
    const chatAppearance = { fontSize: "standard", layout: "wide", assistantWidth };
    assert.deepEqual(validateDesktopUiStatePatch({ chatAppearance }), { chatAppearance });
  }

  for (const chatAppearance of [
    { fontSize: "large" },
    { layout: "wide" },
    { fontSize: "large", layout: "full" },
    { fontSize: "future", layout: "full" },
    { fontSize: "standard", layout: "wide", assistantWidth: "max" },
    { fontSize: "standard", layout: "wide", assistantWidth: null },
    null,
  ]) {
    assert.throws(() => validateDesktopUiStatePatch({ chatAppearance }), /Invalid chat appearance/);
  }
});

test("renderer UI state rejects unknown fields and malformed background mode", () => {
  assert.throws(() => validateDesktopUiStatePatch(null), /Invalid UI state patch/);
  assert.throws(() => validateDesktopUiStatePatch({ window: {} }), /Unsupported UI state field/);
  assert.throws(() => validateDesktopUiStatePatch({ backgroundMode: "yes" }), /must be a boolean/);
  assert.throws(() => validateDesktopUiStatePatch({ managedProcessesEnabled: "yes" }), /must be a boolean/);
});

test("language preference permits only supported locales across the IPC boundary", () => {
  for (const language of ["en-US", "zh-CN", "zh-TW"]) {
    assert.deepEqual(validateDesktopUiStatePatch({ language }), { language });
  }
  for (const language of [null, undefined, {}, "zh-HK", "", 42]) {
    assert.throws(() => validateDesktopUiStatePatch({ language }), /Invalid app language/);
  }
});
