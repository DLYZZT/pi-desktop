import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

const { MarkdownBody, getMarkdownComponentIdentityForTest, parseStats } = await importTestBundle(
  "src/renderer/components/markdown-body-component-identity",
  {
    stdin: {
      contents:
        'export { MarkdownBody, getMarkdownComponentIdentityForTest } from "./MarkdownBody.tsx"; export { parseStats } from "@/lib/markdown";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-markdown", "mermaid"],
    plugins: [
      {
        name: "markdown-body-stubs",
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) => ({ path: args.path, namespace: "stub" }));
          build.onResolve({ filter: /^\.\/SessionProfiler$/ }, () => ({ path: "profiler", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            loader: "js",
            contents:
              args.path === "@/hooks/useTheme"
                ? "export const useTheme = () => ({ isDark: false });"
                : args.path === "@/i18n"
                  ? "export const useI18n = () => ({ language: 'en-US', t: (_key, fallback) => fallback });"
                  : args.path === "@/lib/file-links"
                    ? "export const resolveLocalFileHref = () => null;"
                    : args.path === "@/lib/markdown"
                      ? "export const parseStats = { count: 0 }; export const markdownRehypePlugins = []; export const markdownRemarkPlugins = [() => () => { parseStats.count++; }];"
                      : args.path === "@/lib/code-highlight-policy"
                        ? "export const shouldHighlightCode = () => false;"
                        : args.path === "@/lib/chat-appearance"
                          ? "export const scaledChatFont = (value) => `${value}px`;"
                          : args.path === "@/lib/mermaid-renderer"
                            ? "export const mermaidCacheKey = () => 'key'; export const renderMermaidSvg = async () => '<svg />';"
                            : args.path === "@/hooks/useCopyFeedback"
                              ? "export const useCopyFeedback = () => ({ copied: false, copy: async () => true });"
                              : args.path === "@/lib/syntax-highlight"
                                ? "export const SyntaxHighlighter = 'pre'; export const vs = {}; export const vscDarkPlus = {};"
                                : "export const SessionProfiler = ({ children }) => children;",
          }));
        },
      },
    ],
  },
);

test("Markdown custom component types are module-stable", () => {
  const first = getMarkdownComponentIdentityForTest();
  const second = getMarkdownComponentIdentityForTest();

  assert.equal(first, second);
  for (const name of ["code", "pre", "a", "img", "table"]) assert.equal(first[name], second[name]);
});

test("stable Markdown skips parsing and long streaming updates never enter the Markdown parser", async (t) => {
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    if (oldAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
  });
  const before = parseStats.count;
  await act(async () => {
    renderer = create(createElement(MarkdownBody, null, "stable content"));
  });
  assert.equal(parseStats.count, before + 1);
  await act(async () => renderer.update(createElement(MarkdownBody, null, "stable content")));
  assert.equal(parseStats.count, before + 1);
  for (let i = 0; i < 10; i++) {
    await act(async () =>
      renderer.update(createElement(MarkdownBody, { isStreaming: true }, "growing ".repeat(500) + i)),
    );
  }
  assert.equal(parseStats.count, before + 1);
  await act(async () =>
    renderer.update(createElement(MarkdownBody, { isStreaming: false }, "growing ".repeat(500) + 9)),
  );
  assert.equal(parseStats.count, before + 2);
});
