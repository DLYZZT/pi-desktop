import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MessageView, withGeneratedImageReply, RetryStatus } = await importTestBundle(
  "src/renderer/components/message-view",
  {
    stdin: {
      contents:
        'export { MessageView } from "./MessageView.tsx"; export { RetryStatus } from "./composer/RetryStatus.tsx"; export { withGeneratedImageReply } from "../lib/generated-image-reply.ts";',
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
  },
);

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

test("an aborted response keeps partial text and shows a neutral stopped status instead of a provider error", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistant({
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
        content: [{ type: "text", text: "Partial reply" }],
      }),
    }),
  );
  assert.match(html, /Partial reply/);
  assert.match(html, /Response stopped/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Model request failed|Check the API key|role="alert"/);
  const empty = renderToStaticMarkup(createElement(MessageView, { message: assistant({ stopReason: "aborted" }) }));
  assert.match(empty, /Response stopped/);
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

test("only an actual Auto switch adds a reason and both model names to the existing retry row", () => {
  const retryInfo = { attempt: 1, maxAttempts: 3, errorMessage: "503 temporary failure" };
  const render = (info) => renderToStaticMarkup(createElement(RetryStatus, { retryInfo: info }));
  const same = render(retryInfo);
  assert.match(same, /Retrying/);
  assert.match(same, /503 temporary failure/);
  assert.doesNotMatch(same, /Auto switched/);
  const switched = render({ ...retryInfo, modelSwitch: { from: "fixture/fast", to: "fixture/strong" } });
  assert.match(switched, /Auto switched from fixture\/fast to fixture\/strong after the failed attempt/);
  assert.equal((switched.match(/role="status"/g) ?? []).length, 1);
});

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

test("CLI command cards show saved output, exit status, cancellation and truncation without running commands", () => {
  const message = {
    role: "bashExecution",
    content: [
      { type: "text", text: "echo <data>" },
      { type: "text", text: "tail" },
    ],
    exitCode: 0,
    cancelled: false,
    truncated: true,
    fullOutputPath: "/tmp/cli.log",
  };
  const render = (extra) => renderToStaticMarkup(createElement(MessageView, { message: { ...message, ...extra } }));
  const saved = render({});
  assert.match(saved, /!echo &lt;data&gt;/);
  assert.match(saved, /tail/);
  assert.match(saved, /Exit code 0/);
  assert.match(saved, /Full output saved to \/tmp\/cli.log/);
  assert.match(saved, /Copy path/);
  assert.doesNotMatch(saved, /href=|Run command/);
  assert.match(
    renderToStaticMarkup(createElement(MessageView, { message, sessionId: "s", entryId: "b" })),
    /Preview full output/,
  );
  const failed = render({
    exitCode: 137,
    cancelled: true,
    excludeFromContext: true,
    fullOutputPath: undefined,
    fullOutputError: "disk full",
  });
  assert.match(failed, /!!echo/);
  assert.match(failed, /Cancelled/);
  assert.match(failed, /Exit code 137/);
  assert.match(failed, /disk full/);
  assert.match(failed, /Excluded from model context/);
});

test("a collapsed read image card explains the recorded model's placeholder, including for deferred images", () => {
  const result = {
    role: "toolResult",
    toolName: "read",
    toolCallId: "photo",
    isError: false,
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    details: { imageUnsupportedByModel: "text-only-$&" },
  };
  assert.match(renderToolResult(result), /text-only-\$&amp; received a placeholder/);
  assert.match(renderToolResult({ ...result, content: [] }), /received a placeholder/);
  assert.match(
    renderToolResult({
      ...result,
      details: undefined,
      deferredDetails: { entryId: "entry", originalBytes: 400000, contentType: "details" },
      readImagePlaceholderModel: "deferred-model",
    }),
    /deferred-model received a placeholder/,
  );
  assert.doesNotMatch(renderToolResult({ ...result, details: undefined }), /received a placeholder/);
  assert.doesNotMatch(renderToolResult({ ...result, toolName: "another-tool" }), /received a placeholder/);
});

test("tool images render from persisted content without depending on the temporary image file", () => {
  const result = {
    role: "toolResult",
    toolCallId: "image-result",
    toolName: "codemode",
    content: [
      { type: "text", text: "[Image saved to /tmp/already-removed.png]" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "d29ybGQ=" } },
    ],
    isError: false,
  };
  const before = JSON.stringify(result);
  const html = renderToolResult(result);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,aGVsbG8="/);
  assert.match(html, /<img[^>]+src="data:image\/webp;base64,d29ybGQ="/);
  assert.match(html, /alt="Tool result image"/);
  assert.doesNotMatch(html, /src="[^"]*already-removed/);
  assert.equal(JSON.stringify(result), before);
});

test("tool images wait for deferred data and never fetch a remote image or an arbitrary MIME type", () => {
  const html = renderToolResult({
    role: "toolResult",
    toolCallId: "deferred-image",
    toolName: "codemode",
    content: [
      {
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png",
        deferredContent: { entryId: "entry", originalBytes: 10 },
      },
      { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
      { type: "image", data: "aGVsbG8=", mimeType: "image/svg+xml" },
    ],
    isError: false,
  });
  assert.doesNotMatch(html, /<img|example\.invalid|data:image/);
});

test("generated images appear in the final reply without rendering tool details or changing the transcript", () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const result = {
    role: "toolResult",
    toolCallId: "generated",
    toolName: "codemode",
    content: [{ type: "text", text: "PRIVATE_PROCESS_DETAILS" }, image],
    details: { calls: [{ name: "models.generateImages", status: "ok" }] },
  };
  const answer = assistant({ content: [{ type: "text", text: "Your picture is ready." }] });
  const messages = [{ role: "user", content: "Make a picture" }, result, answer];
  const before = JSON.stringify(messages);
  const reply = withGeneratedImageReply(answer, answer, messages, 1, 3);
  const html = renderToStaticMarkup(createElement(MessageView, { message: reply }));
  assert.match(html, /Your picture is ready/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,aGVsbG8="/);
  assert.match(html, /alt="Image in reply"/);
  assert.doesNotMatch(html, /PRIVATE_PROCESS_DETAILS|codemode|Load full content/);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(reply.content.at(-1), image);
});

test("reply projection stays within its turn, excludes read images and retains successful output after a later failure", () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const generated = {
    role: "toolResult",
    toolCallId: "gen",
    toolName: "codemode",
    content: [image, image],
    details: { calls: [{ name: "models.generateImages", status: "ok" }] },
    isError: true,
  };
  const read = { ...generated, toolCallId: "read", details: { calls: [{ name: "read", status: "ok" }] } };
  const failed = {
    ...generated,
    toolCallId: "failed",
    details: { calls: [{ name: "models.generateImages", status: "error" }] },
  };
  const answer = assistant({ content: [{ type: "text", text: "Done" }] });
  assert.equal(withGeneratedImageReply(answer, answer, [generated, read, failed], 1, 3), answer);
  const reply = withGeneratedImageReply(null, answer, [generated, read, failed], 0, 3);
  assert.equal(reply.content.length, 1);
  assert.equal(reply.content[0], image);
});

test("deferred generated images keep the tool entry reference for automatic history loading", () => {
  const image = {
    type: "image",
    source: { type: "url", url: "" },
    deferredContent: { entryId: "tool-entry", blockIndex: 2, originalBytes: 700000, contentType: "image" },
  };
  const result = {
    role: "toolResult",
    toolCallId: "gen",
    toolName: "codemode",
    content: [image],
    details: { calls: [{ name: "models.generateImages", status: "ok" }] },
  };
  const answer = assistant({ content: [{ type: "text", text: "Done" }] });
  const reply = withGeneratedImageReply(answer, answer, [result], 0, 1);
  assert.equal(reply.content.at(-1), image);
  const html = renderToStaticMarkup(
    createElement(MessageView, { message: reply, onLoadDeferredContent: async () => {} }),
  );
  assert.match(html, /Loading image/);
  assert.doesNotMatch(html, /Load full content/);
});

test("omitted tool result and custom message details offer a separate load action", () => {
  const deferredDetails = { entryId: "result-entry", originalBytes: 300 * 1024, contentType: "details" };
  const result = {
    role: "toolResult",
    toolCallId: "edit",
    toolName: "edit",
    content: [{ type: "text", text: "edited" }],
    deferredDetails,
  };
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistant({ content: [{ type: "toolCall", toolCallId: "edit", toolName: "edit", input: {} }] }),
      toolResults: new Map([["edit", result]]),
      onLoadDeferredContent: async () => {},
    }),
  );
  assert.match(html, /Load full details \(300(\.0)? KB\)/);
  assert.doesNotMatch(html, /Load full content/);
  assert.doesNotMatch(renderToolResult(result), /Load full details/, "no loader, no action");
  const custom = renderToStaticMarkup(
    createElement(MessageView, {
      message: { role: "custom", customType: "report", content: "report", display: true, deferredDetails },
      onLoadDeferredContent: async () => {},
    }),
  );
  assert.match(custom, /Load full details/);
});

test("inline structured tool details start collapsed while diffs retain their dedicated view", () => {
  const result = {
    role: "toolResult",
    toolCallId: "lookup",
    toolName: "mcp_search",
    content: [{ type: "text", text: "result summary" }],
    details: { structuredContent: { status: "structured result content" } },
  };
  const html = renderToolResult(result);
  assert.match(html, /Show details/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /structured result content/);
  assert.match(html, /result summary/);

  const diff = renderToolResult({
    ...result,
    toolName: "edit",
    details: { diff: "@@ -1 +1 @@\n-before\n+after" },
  });
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
  assert.doesNotMatch(diff, /Show details|Tool result details/);
});

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
