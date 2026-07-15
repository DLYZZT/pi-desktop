import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../../../.artifacts/test-modules",
  `feishu-rich-renderer-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents:
      'export { buildFeishuStreamingCard, FEISHU_STREAM_ELEMENT_ID, FeishuRichMessageBuilder, sanitizeFeishuMarkdown } from "./rich-renderer.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "feishu-rich-renderer-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});

const { buildFeishuStreamingCard, FEISHU_STREAM_ELEMENT_ID, FeishuRichMessageBuilder, sanitizeFeishuMarkdown } =
  await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

test("builds a JSON 2.0 streaming card with a stable Markdown element", () => {
  const card = buildFeishuStreamingCard();
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.update_multi, true);
  assert.equal(card.body.elements[0].tag, "markdown");
  assert.equal(card.body.elements[0].element_id, FEISHU_STREAM_ELEMENT_ID);
  assert.match(card.body.elements[0].content, /正在思考/);
});

test("preserves standard Markdown while blocking raw card tags and unsafe links", () => {
  const rendered = sanitizeFeishuMarkdown(
    "## 标题\n\n**粗体** [安全](https://example.com) [危险](file:///etc/passwd) <at id='all'>x</at>",
  );
  assert.match(rendered, /## 标题/);
  assert.match(rendered, /\*\*粗体\*\*/);
  assert.match(rendered, /\[安全\]\(https:\/\/example\.com\)/);
  assert.doesNotMatch(rendered, /file:\/\//);
  assert.doesNotMatch(rendered, /<at/);
  assert.match(rendered, /&lt;at/);
});

test("streams thinking, tool progress, and answer then folds process details in the final card", () => {
  const builder = new FeishuRichMessageBuilder();
  builder.update({
    type: "message",
    phase: "update",
    message: {
      role: "assistant",
      model: "fixture",
      provider: "fixture",
      content: [
        { type: "thinking", thinking: "先检查项目" },
        { type: "text", text: "正在形成 **答案**" },
      ],
    },
  });
  builder.update({ type: "tool_start", toolCallId: "tool-1", toolName: "read_file", args: { path: "README.md" } });
  builder.update({
    type: "tool_end",
    toolCallId: "tool-1",
    toolName: "read_file",
    result: { ok: true, token: "fixture-secret" },
    isError: false,
  });

  const draft = builder.renderDraft();
  assert.match(draft, /思考过程/);
  assert.match(draft, /先检查项目/);
  assert.match(draft, /工具 · read_file · 完成/);
  assert.match(draft, /正在形成 \*\*答案\*\*/);
  assert.doesNotMatch(draft, /fixture-secret/);

  const final = builder.renderFinal("## 最终答案\n\n- 一\n- 二");
  assert.equal(final.answerTruncated, false);
  const elements = final.card.body.elements;
  assert.equal(elements[0].tag, "collapsible_panel");
  assert.equal(elements[0].expanded, false);
  assert.match(elements[0].elements[0].content, /read_file/);
  assert.equal(elements[1].tag, "markdown");
  assert.match(elements[1].content, /## 最终答案/);
});

test("oversized answers explicitly switch to the lossless plain-text fallback", () => {
  const builder = new FeishuRichMessageBuilder();
  const rendered = builder.renderFinal("汉".repeat(20_000));
  assert.equal(rendered.answerTruncated, true);
  assert.match(rendered.card.body.elements.at(-1).content, /下一条普通消息/);
  assert.ok(Buffer.byteLength(JSON.stringify(rendered.card), "utf8") < 28_000);
});

test("partial and hostile tool snapshots cannot crash card rendering", () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("no enumeration");
      },
      get() {
        throw new Error("no access");
      },
    },
  );
  const builder = new FeishuRichMessageBuilder();
  builder.update({
    type: "tool_update",
    toolCallId: "partial",
    toolName: undefined,
    args: hostile,
    partialResult: hostile,
  });
  assert.doesNotThrow(() => builder.renderDraft());
  assert.match(builder.renderDraft(), /tool/);
});
