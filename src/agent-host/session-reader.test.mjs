import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../.artifacts/test-modules", `session-reader-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { buildSessionContext } from "./session-reader.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "session-reader-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { buildSessionContext } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const timestamp = "2026-07-15T12:00:00.000Z";

test("hidden channel markers annotate UI user messages without entering displayed history", () => {
  const entries = [
    {
      type: "custom",
      id: "source",
      parentId: null,
      timestamp,
      customType: "pi-desktop-channel-source",
      data: { channel: "telegram", runId: "run-one" },
    },
    {
      type: "message",
      id: "user",
      parentId: "source",
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, "telegram");
  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(context.entryIds, ["user"]);
});

test("cancelled channel markers do not color a later local message", () => {
  const entries = [
    {
      type: "custom",
      id: "source",
      parentId: null,
      timestamp,
      customType: "pi-desktop-channel-source",
      data: { channel: "weixin", runId: "run-one" },
    },
    {
      type: "custom",
      id: "cancel",
      parentId: "source",
      timestamp,
      customType: "pi-desktop-channel-source-cancelled",
      data: { runId: "run-one" },
    },
    {
      type: "message",
      id: "user",
      parentId: "cancel",
      timestamp,
      message: { role: "user", content: "local" },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, undefined);
});

test("legacy external prompt wrappers are hidden in UI and still recover the source", () => {
  const entries = [
    {
      type: "message",
      id: "legacy",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "[外部消息来源：飞书 / Lark]\n发送者标识：123\n---\n用户实际输入",
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, "feishu");
  assert.equal(context.messages[0].content[0].text, "用户实际输入");
  assert.equal(context.messages[0].content[1].type, "image");
});

test("internal attachment context is omitted from UI history", () => {
  const entries = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "inspect this file" },
    },
    {
      type: "custom_message",
      id: "attachment",
      parentId: "user",
      timestamp,
      customType: "pi-desktop-channel-attachment-context",
      content: "Attachment at /private/path",
      display: false,
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
});
