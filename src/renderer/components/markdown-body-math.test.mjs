import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importTestBundle } from "#test-bundle";

const { MarkdownBody, loadMarkdownPlugins } = await importTestBundle("markdown-body-math", {
  stdin: {
    contents:
      'export { MarkdownBody } from "./MarkdownBody.tsx"; export { loadMarkdownPlugins } from "@/lib/markdown";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: "tsconfig.renderer.json",
  packages: "external",
  define: { "import.meta.env.DEV": "false" },
  plugins: [
    {
      name: "plain-code-highlighter",
      setup(build) {
        build.onResolve({ filter: /katex\/dist\/katex\.min\.css$/ }, () => ({ path: "css", namespace: "test-css" }));
        build.onLoad({ filter: /.*/, namespace: "test-css" }, () => ({ contents: "", loader: "js" }));
        build.onResolve({ filter: /^@\/lib\/syntax-highlight$/ }, (args) => ({
          path: args.path,
          namespace: "test-highlighter",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-highlighter" }, () => ({
          resolveDir: import.meta.dirname,
          contents:
            'import { createElement } from "react"; export const SyntaxHighlighter = ({ children }) => createElement("pre", {"data-highlighted":true}, children); export const vs = {}; export const vscDarkPlus = {};',
        }));
      },
    },
  ],
});

// Static rendering does not run effects. Load the optional plugins first for
// these formatting regressions; the lazy-loading tests exercise the effects.
await loadMarkdownPlugins({ math: true, html: true });

function render(markdown) {
  return renderToStaticMarkup(createElement(MarkdownBody, null, markdown));
}

const followingMarkdown = `

---

### Following heading

**Following bold text**

| Name | Value |
| --- | --- |
| Result | 42 |

Line one<br>Line two

$$x = 2！$$

Final paragraph.`;

test("long streaming text keeps finished blocks formatted and restores complete Markdown at settlement", () => {
  const source = followingMarkdown.repeat(20) + "\n<script>unsafe()</script>";
  const streaming = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, source));
  assertFollowingMarkdown(streaming);
  assert.match(streaming, /class="katex/);
  assert.doesNotMatch(streaming, /data-streaming-preview|<script>/);
  const settled = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: false }, source));
  assertFollowingMarkdown(settled);
  assert.match(settled, /class="katex/);
  assert.doesNotMatch(settled, /data-streaming-preview|<script>/);
});

test("streaming highlights finished code blocks and renders an unfinished fence without the parser", () => {
  const source = "```typescript\nconst done = 1;\n```\n\nText\n\n```python\n" + "print('x')\n".repeat(2000);
  const streaming = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, source));
  assert.equal((streaming.match(/data-highlighted/g) ?? []).length, 1);
  assert.match(streaming, /<span class="markdown-code-lang">python<\/span>/);
  assert.doesNotMatch(streaming, /data-streaming-preview|```/);
});

test("a long code block is highlighted once its fence closes while the message is still streaming", () => {
  const code = "```python\n" + "print('a long line of code')\n".repeat(600) + "```";
  for (const suffix of ["", "\n", "\n\n", "\nNext paragraph", "\n\nNext paragraph"]) {
    const streaming = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, code + suffix));
    assert.equal((streaming.match(/data-highlighted/g) ?? []).length, 1, JSON.stringify(suffix));
    assert.doesNotMatch(streaming, /data-streaming-preview|```/);
  }
});

test("reference links resolve during streaming when the definition is in a later block", () => {
  const source =
    "Read the [acceptance doc][guide] first.\n\nAn ordinary paragraph.\n\n[guide]: https://example.com/guide\n\nStill streaming";
  const streaming = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, source));
  assert.match(streaming, /<a href="https:\/\/example\.com\/guide"[^>]*>acceptance doc<\/a>/);
  assert.doesNotMatch(streaming, /\[guide\]/);
  const pending = renderToStaticMarkup(
    createElement(MarkdownBody, { isStreaming: true }, "Read the [acceptance doc][guide] first.\n\nAn ordinary"),
  );
  assert.match(pending, /\[acceptance doc\]\[guide\]/);
});

test("an oversized unfinished paragraph falls back to an escaped preview for the tail only", () => {
  const source = "# Title\n\n" + "word <b>x</b> ".repeat(1000);
  const streaming = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, source));
  assert.match(streaming, /<h1>Title<\/h1>/);
  assert.match(streaming, /data-streaming-preview/);
  assert.match(streaming, /&lt;b&gt;/);
});

test("small streaming code stays readable without highlighting and highlights once its fence closes", () => {
  const open = "```typescript\nconst answer = 42;\n";
  const preview = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, open));
  assert.match(preview, /const answer = 42;/);
  assert.doesNotMatch(preview, /data-highlighted/);
  const closed = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, open + "```"));
  assert.match(closed, /data-highlighted/);
  const settled = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: false }, open + "```"));
  assert.match(settled, /data-highlighted/);
});

function assertFollowingMarkdown(html) {
  assert.match(html, /<h3>Following heading<\/h3>/);
  assert.match(html, /<strong>Following bold text<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>42<\/td>/);
  assert.match(html, /Line one<br\/>Line two/);
  assert.match(html, /<p>Final paragraph\.<\/p>/);
}

for (const [name, prefix, indent] of [
  ["ordered list", "3. Formula:", "   "],
  ["unordered list", "- Formula:", "  "],
  ["nested list", "- Outer\n  - Formula:", "    "],
  ["blockquote", "> Formula:", "> "],
  ["top level", "Formula:\n", ""],
  ["indented top level", "Formula:\n", "   "],
]) {
  for (const lineBreak of ["\n", "\r\n"]) {
    test(`single-line display math preserves following Markdown: ${name}, ${JSON.stringify(lineBreak)}`, () => {
      const markdown = `${prefix}\n${indent}$$\\text{range} = \\frac{520}{24} \\approx 21.6！$$${followingMarkdown}`;
      const html = render(markdown.replaceAll("\n", lineBreak));
      assertFollowingMarkdown(html);
      assert.doesNotMatch(html, /katex-error/);
      assert.match(html, /class="katex"/);
      if (name === "ordered list" || name === "unordered list") {
        assert.match(html, /<li>[\s\S]*class="katex-display"[\s\S]*<\/li>/);
      }
    });
  }
}

test("invalid list formula falls back locally without swallowing subsequent Markdown", () => {
  const html = render(`3. Formula:\n   $$\\frac{1}{$$${followingMarkdown}`);
  assertFollowingMarkdown(html);
  assert.equal((html.match(/class="katex-error"/g) ?? []).length, 1);
  assert.match(html, /<span class="katex-error"[^>]*>\\frac\{1\}\{<\/span>/);
});

test("formula normalization preserves factorials and fullwidth punctuation", () => {
  const html = render("3. Formula:\n   $$n! + n!! + 1！$$");
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<annotation encoding="application\/x-tex">n! \+ n!! \+ 1！<\/annotation>/);
});

test("fenced code examples stay literal and properly indented multiline math still renders", () => {
  const html = render(`\`\`\`text\n   $$x=1$$\n\`\`\`\n\n3. Formula:\n   $$\n   x=1\n   $$${followingMarkdown}`);
  assertFollowingMarkdown(html);
  assert.match(html, /\$\$x=1\$\$/);
  assert.doesNotMatch(html, /katex-error/);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
});
