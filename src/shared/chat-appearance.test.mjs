import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_FONT_SCALE,
  CHAT_FONT_SIZES,
  CHAT_LAYOUTS,
  DEFAULT_CHAT_APPEARANCE,
  isChatAppearancePreferences,
  normalizeChatAppearance,
} from "./chat-appearance.ts";

test("chat appearance exposes the four font sizes and two layout modes", () => {
  assert.deepEqual(CHAT_FONT_SIZES, ["small", "standard", "large", "extra-large"]);
  assert.deepEqual(CHAT_LAYOUTS, ["fixed", "wide"]);
  assert.deepEqual(CHAT_FONT_SCALE, { small: 0.9, standard: 1, large: 1.15, "extra-large": 1.3 });
  assert.deepEqual(DEFAULT_CHAT_APPEARANCE, { fontSize: "standard", layout: "fixed" });
});

test("normalization preserves known values and repairs fields independently", () => {
  for (const fontSize of CHAT_FONT_SIZES) {
    for (const layout of CHAT_LAYOUTS) {
      const value = { fontSize, layout };
      assert.equal(isChatAppearancePreferences(value), true);
      assert.deepEqual(normalizeChatAppearance(value), value);
    }
  }

  assert.deepEqual(normalizeChatAppearance({ fontSize: "large", layout: "future" }), {
    fontSize: "large",
    layout: "fixed",
  });
  assert.deepEqual(normalizeChatAppearance({ fontSize: 2, layout: "wide" }), {
    fontSize: "standard",
    layout: "wide",
  });
});

test("normalization migrates the removed full-width value to wide", () => {
  const legacy = { fontSize: "large", layout: "full" };
  assert.equal(isChatAppearancePreferences(legacy), false);
  assert.deepEqual(normalizeChatAppearance(legacy), { fontSize: "large", layout: "wide" });
});

test("malformed chat appearance values use backward-compatible defaults", () => {
  for (const value of [undefined, null, true, "large", [], { fontSize: "future" }]) {
    assert.deepEqual(normalizeChatAppearance(value), { fontSize: "standard", layout: "fixed" });
    assert.equal(isChatAppearancePreferences(value), false);
  }
});
