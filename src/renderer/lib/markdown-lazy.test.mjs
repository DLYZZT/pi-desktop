import assert from "node:assert/strict";
import test from "node:test";
import { createElement, StrictMode } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { Markdown, state } = await importTestBundle("lazy-markdown-plugins", {
  stdin: {
    contents: `
      import { createElement } from "react";
      import ReactMarkdown from "react-markdown";
      import { useMarkdownPlugins } from "./markdown.ts";
      export { state } from "markdown-test-state";
      export function Markdown({ children }) {
        return createElement(ReactMarkdown, useMarkdownPlugins(children), children);
      }
    `,
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: "tsconfig.renderer.json",
  packages: "external",
  plugins: [
    {
      name: "track-optional-markdown-plugins",
      setup(build) {
        build.onResolve({ filter: /^markdown-test-state$/ }, () => ({ path: "state", namespace: "markdown-test" }));
        build.onResolve({ filter: /^\.\/markdown-math$|^rehype-raw$/ }, ({ path, namespace }) =>
          namespace === "markdown-test" ? undefined : { path, namespace: "markdown-test" },
        );
        build.onLoad({ filter: /.*/, namespace: "markdown-test" }, ({ path }) => {
          if (path === "state") return { contents: "export const state = { math: 0, html: 0 };" };
          const math = path === "./markdown-math";
          return {
            resolveDir: import.meta.dirname,
            contents: `import { state } from "markdown-test-state";
            state.${math ? "math" : "html"}++;
            export { default } from "${math ? "rehype-katex" : "rehype-raw"}";`,
          };
        });
      },
    },
  ],
});

test("Markdown loads plugins for parsed math/HTML only and keeps sanitized content through updates", async (t) => {
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    if (oldAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
  });
  async function render(source) {
    await act(async () => {
      const element = createElement(StrictMode, null, createElement(Markdown, null, source));
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  }
  await render(
    "Plain **Markdown**, $5\n\n\\$escaped\\$\n\n `<b>$x$</b>` and <https://example.com>\n\n```html\n<b>$y$</b>\n```",
  );
  assert.deepEqual(state, { math: 0, html: 0 });
  assert.equal(renderer.root.findAllByType("strong").length, 1);

  await render("An equation: $x^2$.");
  assert.deepEqual(state, { math: 1, html: 0 });
  assert.ok(renderer.root.findAll((node) => node.props.className === "katex").length > 0);

  await render(
    '<details open><summary>Details</summary>Safe</details><script>unsafe()</script><img src="x" onerror="unsafe()"><a href="javascript:unsafe()">bad</a>',
  );
  assert.deepEqual(state, { math: 1, html: 1 });
  assert.equal(renderer.root.findAllByType("summary").length, 1);
  assert.equal(renderer.root.findAllByType("script").length, 0);
  assert.equal(renderer.root.findByType("img").props.onError, undefined);
  assert.ok(!renderer.root.findByType("a").props.href?.startsWith("javascript:"));

  await render("Ordinary text again");
  await render("$z$<br>done");
  assert.deepEqual(state, { math: 1, html: 1 });
  assert.equal(renderer.root.findAllByType("br").length, 1);
  assert.ok(renderer.root.findAll((node) => node.props.className === "katex").length > 0);
});
