import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { getMarkdownComponentIdentityForTest } = await importTestBundle(
  "src/renderer/components/markdown-body-component-identity",
  {
    entryPoints: [fileURLToPath(new URL("./MarkdownBody.tsx", import.meta.url))],
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
                : args.path === "@/lib/file-links"
                  ? "export const resolveLocalFileHref = () => null;"
                  : args.path === "@/lib/markdown"
                    ? "export const markdownRehypePlugins = []; export const markdownRemarkPlugins = [];"
                    : args.path === "@/lib/code-highlight-policy"
                      ? "export const shouldHighlightCode = () => false;"
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
