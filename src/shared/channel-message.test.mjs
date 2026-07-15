import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../.artifacts/test-modules", `channel-message-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "channel-message.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER, channelPromptText } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

test("attachment-only prompts use a non-empty metadata-free text block", () => {
  assert.equal(channelPromptText("", true), CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER);
  assert.equal(channelPromptText("   ", true), CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER);
  assert.equal(CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER, "\uFFFC");
  assert.notEqual(CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER.trim(), "");
});

test("actual user text is passed through byte-for-byte", () => {
  assert.equal(channelPromptText("  hello\n", true), "  hello\n");
  assert.equal(channelPromptText("", false), "");
});
