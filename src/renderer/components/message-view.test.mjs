import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MessageView } = await importTestBundle("src/renderer/components/message-view", {
  stdin: {
    contents: 'export { MessageView } from "./MessageView.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "message-view-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "stub-markdown-body",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/MarkdownBody$/ }, () => ({
          path: "markdown-body",
          namespace: "message-view-test",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "message-view-test" }, () => ({
          contents:
            'import { createElement } from "react"; export function MarkdownBody({ children }) { return createElement("div", null, children); }',
          loader: "js",
        }));
      },
    },
  ],
});

test("MessageView is memoized to preserve unchanged historical messages", () => {
  assert.equal(MessageView.$$typeof, Symbol.for("react.memo"));
});

test("keeps the user copy action without timestamp or branch actions", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: { role: "user", content: "copy me" },
    }),
  );

  assert.match(html, /title="Copy message"/);
});

test("channel attachment placeholders expose meaningful copy text", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: {
        role: "user",
        channelSource: "telegram",
        channelAttachments: [{ kind: "file", name: "report.pdf", mime: "application/pdf" }],
        content: [{ type: "text", text: "\uFFFC" }],
      },
    }),
  );

  assert.match(html, /Attachment: report\.pdf \(application\/pdf\)/);
  assert.match(html, /title="Copy message"/);
});

test("legacy attachment placeholders without metadata disable copy", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: { role: "user", channelSource: "weixin", content: "\uFFFC" },
    }),
  );

  assert.match(html, /title="Nothing to copy"/);
  assert.match(html, /disabled=""/);
});

function assistant(overrides = {}) {
  return {
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    ...overrides,
  };
}

test("renders an empty provider failure as a persistent alert", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistant({ stopReason: "error", errorMessage: "401: invalid API key" }),
    }),
  );

  assert.match(html, /data-testid="assistant-error-message"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Model request failed/);
  assert.match(html, /401: invalid API key/);
});

test("renders actionable fallback text when a failed response has no provider detail", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistant({ stopReason: "error" }),
    }),
  );

  assert.match(html, /Check the API key, service URL, and model configuration/);
});

test("continues to hide a completed empty non-error assistant message", () => {
  assert.equal(renderToStaticMarkup(createElement(MessageView, { message: assistant() })), "");
});

function toolCallMessage(toolName, toolCallId = "call-1") {
  return assistant({
    content: [{ type: "toolCall", toolCallId, toolName, input: { agent: "scout", task: "find auth" } }],
  });
}

function textItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    role: "assistant",
    content: [{ type: "text", text: `item-${i + 1}` }],
  }));
}

test("live subagent details show agent and child tool instead of running", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: toolCallMessage("subagent"),
      toolResults: new Map([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: [{ type: "text", text: "(running...)" }],
            details: {
              mode: "single",
              results: [
                {
                  agent: "scout",
                  exitCode: 0,
                  messages: [
                    {
                      role: "assistant",
                      content: [{ type: "toolCall", name: "grep", arguments: { pattern: "auth" } }],
                    },
                  ],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                },
              ],
            },
          },
        ],
      ]),
    }),
  );

  assert.match(html, /scout/);
  assert.match(html, /grep/);
  assert.doesNotMatch(html, />running</);
});

test("final subagent details keep a collapsed trail from history", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: toolCallMessage("subagent"),
      toolResults: new Map([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            timestamp: 2_000,
            content: [{ type: "text", text: "done" }],
            details: {
              mode: "single",
              results: [
                {
                  agent: "scout",
                  exitCode: 0,
                  messages: textItems(12),
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                },
              ],
            },
          },
        ],
      ]),
    }),
  );

  assert.match(html, /item-12/);
  assert.doesNotMatch(html, /item-1</);
});

test("running bash without details still shows running", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: toolCallMessage("bash"),
    }),
  );

  assert.match(html, /running/);
});

test("edit details without subagent shape still render as a diff", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: toolCallMessage("edit"),
      toolResults: new Map([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            timestamp: 2_000,
            content: [{ type: "text", text: "ok" }],
            details: { patch: "diff --git a/file b/file\n+hello" },
          },
        ],
      ]),
    }),
  );

  assert.match(html, /\+hello/);
  assert.doesNotMatch(html, /data-testid="subagent-trail"/);
});

test("renders compaction summaries collapsed by default", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: {
        role: "custom",
        customType: "compaction",
        content: "A long summary that should stay hidden until requested.",
        display: true,
      },
    }),
  );

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Conversation compacted/);
  assert.doesNotMatch(html, /A long summary that should stay hidden/);
});
