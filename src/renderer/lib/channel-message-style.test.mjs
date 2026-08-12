import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
const { getUserBubbleColor, USER_BUBBLE_COLORS } = await importTestBundle("src/renderer/lib/channel-message-style", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "channel-message-style.ts")],
});

test("user message bubbles use a stable color for each source", () => {
  assert.equal(getUserBubbleColor(), "#1c1a17");
  assert.equal(getUserBubbleColor("weixin"), "#08783e");
  assert.equal(getUserBubbleColor("telegram"), "#1677a8");
  assert.equal(getUserBubbleColor("feishu"), "#c2410c");
  assert.deepEqual(Object.keys(USER_BUBBLE_COLORS).sort(), ["feishu", "local", "telegram", "weixin"]);
});
