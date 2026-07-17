import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `message-view-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { MessageView } from "./MessageView.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "message-view-test-entry.tsx",
    loader: "tsx",
  },
  outfile: output,
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  bundle: true,
  format: "esm",
  platform: "node",
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
  logLevel: "silent",
});

const { MessageView } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

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
