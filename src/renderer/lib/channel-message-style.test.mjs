import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `channel-style-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "channel-message-style.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { getUserBubbleColor, USER_BUBBLE_COLORS } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

test("user message bubbles use a stable color for each source", () => {
  assert.equal(getUserBubbleColor(), "#1c1a17");
  assert.equal(getUserBubbleColor("weixin"), "#08783e");
  assert.equal(getUserBubbleColor("telegram"), "#1677a8");
  assert.equal(getUserBubbleColor("feishu"), "#c2410c");
  assert.deepEqual(Object.keys(USER_BUBBLE_COLORS).sort(), ["feishu", "local", "telegram", "weixin"]);
});
