import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_FONT_SCALE,
  CHAT_FONT_SIZES,
  CHAT_LAYOUTS,
  CHAT_ASSISTANT_WIDTHS,
  DEFAULT_CHAT_APPEARANCE,
  isChatAppearancePreferences,
  normalizeChatAppearance,
} from "./chat-appearance.ts";

test("chat appearance exposes the four font sizes and two layout modes", () => {
  assert.deepEqual(CHAT_FONT_SIZES, ["small", "standard", "large", "extra-large"]);
  assert.deepEqual(CHAT_LAYOUTS, ["fixed", "wide"]);
  assert.deepEqual(CHAT_FONT_SCALE, { small: 0.9, standard: 1, large: 1.15, "extra-large": 1.3 });
  assert.deepEqual(DEFAULT_CHAT_APPEARANCE, { fontSize: "standard", layout: "fixed", assistantWidth: "comfortable" });
});

test("normalization preserves known values and repairs fields independently", () => {
  for (const fontSize of CHAT_FONT_SIZES) {
    for (const layout of CHAT_LAYOUTS) {
      for (const assistantWidth of CHAT_ASSISTANT_WIDTHS) {
        const value = { fontSize, layout, assistantWidth };
        assert.equal(isChatAppearancePreferences(value), true);
        assert.deepEqual(normalizeChatAppearance(value), value);
      }
    }
  }

  assert.deepEqual(normalizeChatAppearance({ fontSize: "large", layout: "future" }), {
    fontSize: "large",
    layout: "fixed",
    assistantWidth: "comfortable",
  });
  assert.deepEqual(normalizeChatAppearance({ fontSize: 2, layout: "wide", assistantWidth: "comfortable" }), {
    fontSize: "standard",
    layout: "wide",
    assistantWidth: "comfortable",
  });
});

test("normalization migrates the removed full-width value to wide", () => {
  const legacy = { fontSize: "large", layout: "full" };
  assert.equal(isChatAppearancePreferences(legacy), false);
  assert.deepEqual(normalizeChatAppearance(legacy), {
    fontSize: "large",
    layout: "wide",
    assistantWidth: "comfortable",
  });
});

test("malformed chat appearance values use backward-compatible defaults", () => {
  for (const value of [undefined, null, true, "large", [], { fontSize: "future" }]) {
    assert.deepEqual(normalizeChatAppearance(value), {
      fontSize: "standard",
      layout: "fixed",
      assistantWidth: "comfortable",
    });
    assert.equal(isChatAppearancePreferences(value), false);
  }
});

test("legacy preferences default to comfortable replies and invalid reply widths are repaired independently", () => {
  const legacy = { fontSize: "large", layout: "wide" };
  assert.equal(isChatAppearancePreferences(legacy), true);
  assert.deepEqual(normalizeChatAppearance(legacy), { ...legacy, assistantWidth: "comfortable" });
  for (const assistantWidth of [null, "max", 100, {}, []]) {
    const invalid = { ...legacy, assistantWidth };
    assert.equal(isChatAppearancePreferences(invalid), false);
    assert.deepEqual(normalizeChatAppearance(invalid), { ...legacy, assistantWidth: "comfortable" });
  }
});
