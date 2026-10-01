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

test("a historical tool without a canonical result is not displayed as still running", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "interrupted", toolName: "fixture", input: {} }],
      },
      runningToolCallIds: new Set(),
    }),
  );
  assert.match(html, /Result was not recorded in the conversation/);
  assert.doesNotMatch(html, /stream-caret/);
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

test("renders persisted skill invocations collapsed without exposing their instructions", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: {
        role: "user",
        content: `<skill name="review" location="/home/test/.pi/skills/review/SKILL.md">
References are relative to /home/test/.pi/skills/review.

# Review

Private implementation instructions.
</skill>

Check the current change`,
      },
    }),
  );

  assert.match(html, /data-testid="skill-invocation"/);
  assert.match(html, /data-skill-name="review"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Check the current change/);
  assert.doesNotMatch(html, /Private implementation instructions/);
  assert.doesNotMatch(html, /\/home\/test\/\.pi\/skills/);
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

function renderToolResult(result) {
  return renderToStaticMarkup(
    createElement(MessageView, {
      message: assistant({
        content: [{ type: "toolCall", toolCallId: result.toolCallId, toolName: result.toolName, input: {} }],
      }),
      toolResults: new Map([[result.toolCallId, result]]),
    }),
  );
}

function persistedHerdrResult(isError = false, output = "PRIVATE_FIXTURE_OUTPUT") {
  const code = isError && output.includes("HERDR_REQUEST_TIMEOUT") ? "HERDR_REQUEST_TIMEOUT" : null;
  return {
    role: "toolResult",
    toolCallId: "herdr-result",
    toolName: "herdr_list",
    content: [
      {
        type: "text",
        text: code
          ? `[Herdr tool failed: ${code}. Live Herdr content was not saved.]`
          : "[Sensitive Herdr result was not saved. Ask Pi to inspect the live Herdr fleet again.]",
      },
    ],
    isError,
    ...(code ? { details: { errorCode: code } } : {}),
  };
}

test("persisted Herdr results show a neutral history notice without changing the stored message", () => {
  const result = persistedHerdrResult();
  const before = JSON.stringify(result);
  const html = renderToolResult(result);
  assert.match(html, /The original output was not saved in history\./);
  assert.doesNotMatch(html, /Sensitive Herdr result|Ask Pi to inspect|PRIVATE_FIXTURE_OUTPUT|var\(--danger\)/);
  assert.equal(JSON.stringify(result), before);
});

test("persisted Herdr failures remain failures and keep safe diagnostic codes visible", () => {
  for (const [output, code] of [
    ["Unknown failure", null],
    ["HERDR_REQUEST_TIMEOUT: private endpoint", "HERDR_REQUEST_TIMEOUT"],
  ]) {
    const result = persistedHerdrResult(true, output);
    const before = JSON.stringify(result);
    const html = renderToolResult(result);
    assert.match(html, /The tool call failed/);
    assert.match(html, /The original output was not saved in history/);
    assert.match(html, /var\(--danger\)/);
    if (code) assert.match(html, new RegExp(code));
    assert.doesNotMatch(html, /Sensitive Herdr result|Ask Pi to inspect|private endpoint/);
    assert.equal(JSON.stringify(result), before);
    assert.equal(result.isError, true);
  }
});

test("actual tool output and a different tool's text are not mistaken for a Herdr history notice", () => {
  const marker = persistedHerdrResult().content[0].text;
  for (const [name, output] of [
    ["herdr_list", "Live result: pane-42"],
    ["herdr_list", `Quoted: ${marker}`],
    ["bash", marker],
  ]) {
    const html = renderToolResult({
      role: "toolResult",
      toolCallId: "live",
      toolName: name,
      content: [{ type: "text", text: output }],
      isError: false,
    });
    assert.ok(html.includes(output));
    assert.doesNotMatch(html, /The original output was not saved in history/);
  }
});
