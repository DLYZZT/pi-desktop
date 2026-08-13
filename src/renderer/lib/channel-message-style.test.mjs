import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
const { getUserBubbleStyle, USER_BUBBLE_COLORS } = await importTestBundle("src/renderer/lib/channel-message-style", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "channel-message-style.ts")],
});

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test("user message bubbles use distinct light and dark palettes for every source", () => {
  assert.deepEqual(Object.keys(USER_BUBBLE_COLORS).sort(), ["dark", "light"]);
  assert.deepEqual(Object.keys(USER_BUBBLE_COLORS.light).sort(), ["feishu", "local", "telegram", "weixin"]);
  assert.deepEqual(Object.keys(USER_BUBBLE_COLORS.dark).sort(), ["feishu", "local", "telegram", "weixin"]);

  for (const source of Object.keys(USER_BUBBLE_COLORS.light)) {
    const light = getUserBubbleStyle(source, false);
    const dark = getUserBubbleStyle(source, true);
    assert.notEqual(light.background, dark.background, `${source} should respond to theme changes`);
    assert.equal(light.foreground, "#faf9f7");
    assert.equal(dark.foreground, "#faf9f7");
  }
  assert.deepEqual(getUserBubbleStyle(undefined, false), getUserBubbleStyle("local", false));
});

test("every user bubble palette meets WCAG AA text contrast", () => {
  for (const isDark of [false, true]) {
    for (const source of Object.keys(USER_BUBBLE_COLORS.light)) {
      const style = getUserBubbleStyle(source, isDark);
      assert.ok(contrastRatio(style.background, style.foreground) >= 4.5, `${isDark ? "dark" : "light"}/${source}`);
    }
  }
});
