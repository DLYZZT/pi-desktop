import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../../../.artifacts/test-modules",
  `telegram-rich-renderer-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { sanitizeTelegramRichMarkdown, TelegramRichMessageBuilder } from "./rich-renderer.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "telegram-rich-renderer-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});

const { sanitizeTelegramRichMarkdown, TelegramRichMessageBuilder } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

test("sanitizes model Markdown while preserving safe formatting and links", () => {
  const rendered = sanitizeTelegramRichMarkdown(
    "## Title\n\n**bold** <details open>unsafe</details>\n\n![diagram](https://example.test/a.png)\n\n[local](file:///etc/passwd)",
  );
  assert.match(rendered, /^## Title/);
  assert.match(rendered, /\*\*bold\*\*/);
  assert.match(rendered, /&lt;details open&gt;unsafe&lt;\/details&gt;/);
  assert.match(rendered, /\[图片：diagram\]\(https:\/\/example\.test\/a\.png\)/);
  assert.match(rendered, /\n\nlocal$/);
  assert.doesNotMatch(rendered, /file:\/\//);
});

test("streams thinking and tools open, then folds them in the final rich message", () => {
  const builder = new TelegramRichMessageBuilder();
  builder.update({
    type: "message",
    phase: "update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读取 <private> 配置" },
        { type: "text", text: "正在生成 **答案**" },
        {
          type: "toolCall",
          toolCallId: "tool-one",
          toolName: "read",
          input: { path: "README.md", token: "top-secret" },
        },
      ],
    },
  });
  builder.update({
    type: "tool_start",
    toolCallId: "tool-one",
    toolName: "read",
    args: { path: "README.md", token: "top-secret" },
  });

  const draft = builder.renderDraft();
  assert.match(draft, /^<tg-thinking>正在运行工具 read…<\/tg-thinking>/);
  assert.match(draft, /<details open><summary>思考过程<\/summary>/);
  assert.match(draft, /<details open><summary>工具 · read · 运行中<\/summary>/);
  assert.match(draft, /\[REDACTED\]/);
  assert.match(draft, /正在生成 \*\*答案\*\*/);

  builder.update({
    type: "tool_end",
    toolCallId: "tool-one",
    toolName: "read",
    result: "读取完成",
    isError: false,
  });
  const final = builder.renderFinal("## 完成\n\n这是 **最终答案**。");
  assert.doesNotMatch(final, /<tg-thinking>/);
  assert.doesNotMatch(final, /<details open>/);
  assert.match(final, /<details><summary>思考过程<\/summary>/);
  assert.match(final, /<details><summary>工具 · read · 完成<\/summary>/);
  assert.match(final, /---\n\n## 完成\n\n这是 \*\*最终答案\*\*/);
});

test("normalizes partial Pi tool-call snapshots before rendering a draft", () => {
  const builder = new TelegramRichMessageBuilder();
  builder.update({
    type: "message",
    phase: "update",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "native-tool", name: "bash", arguments: { command: "pwd" } },
        { type: "toolCall", id: "unnamed-tool", arguments: {} },
      ],
    },
  });

  const draft = builder.renderDraft();
  assert.match(draft, /工具 · bash · 完成/);
  assert.match(draft, /工具 · tool · 完成/);
  assert.match(draft, /"command": "pwd"/);
});
