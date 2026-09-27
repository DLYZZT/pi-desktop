import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importTestBundle } from "#test-bundle";

const { MarkdownBody } = await importTestBundle("markdown-body-math", {
  entryPoints: [fileURLToPath(new URL("./MarkdownBody.tsx", import.meta.url))],
  tsconfig: "tsconfig.renderer.json",
  packages: "external",
  define: { "import.meta.env.DEV": "false" },
  plugins: [
    {
      name: "plain-code-highlighter",
      setup(build) {
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

test("long streaming text uses a cheap escaped preview and restores complete Markdown at settlement", () => {
  const source = followingMarkdown.repeat(20) + "\n<script>unsafe()</script>";
  const preview = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, source));
  assert.match(preview, /data-streaming-preview/);
  assert.doesNotMatch(preview, /<table>|<script>|class="katex/);
  assert.match(preview, /&lt;script&gt;/);
  const settled = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: false }, source));
  assertFollowingMarkdown(settled);
  assert.match(settled, /class="katex/);
  assert.doesNotMatch(settled, /data-streaming-preview|<script>/);
});

test("small streaming code stays readable without highlighting and highlights once complete", () => {
  const code = "```typescript\nconst answer = 42;\n```";
  const preview = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: true }, code));
  assert.match(preview, /const answer = 42;/);
  assert.doesNotMatch(preview, /data-highlighted/);
  const settled = renderToStaticMarkup(createElement(MarkdownBody, { isStreaming: false }, code));
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
