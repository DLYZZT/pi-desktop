import assert from "node:assert/strict";
import test from "node:test";

import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { markdownRehypePlugins, markdownRemarkPlugins } from "./markdown.ts";

test("Markdown plugins preserve GFM/math and sanitize raw HTML before KaTeX", () => {
  assert.deepEqual(markdownRemarkPlugins, [remarkGfm, remarkMath]);
  assert.equal(markdownRehypePlugins[0], rehypeRaw);
  assert.equal(markdownRehypePlugins[1][0], rehypeSanitize);
  assert.equal(markdownRehypePlugins[2][0], rehypeKatex);
  assert.deepEqual(markdownRehypePlugins[2][1], { throwOnError: false, strict: false });
  const schema = markdownRehypePlugins[1][1];
  assert.deepEqual(schema.strip.slice(-4), ["iframe", "object", "style", "form"]);
  assert.deepEqual(schema.attributes.code, [["className", /^language-./, "math-inline", "math-display"]]);
});

async function loadSubject() {
  return import("./markdown.ts");
}

const WB = String.raw;

test("autolinks Windows absolute path with spaces (trailing word cut)", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown(WB`Build: C:\Users\tester\x\Pi Agent Desktop.exe big`);
  assert.ok(out.includes(WB`[C:\Users\tester\x\Pi Agent Desktop.exe]`), out);
  // href must be a canonical file:/// URL — a bare "C:\" href is stripped by the sanitizer
  assert.ok(out.includes("](file:///C:/Users/tester/x/Pi%20Agent%20Desktop.exe)"), out);
  assert.ok(!out.includes("big]"), out + " <- 'big' must stay outside link");
});

test("autolinks posix absolute path", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("file at /home/me/project/src/main.ts line 5");
  assert.ok(out.includes("[/home/me/project/src/main.ts]"), out);
});

test("autolinks bare https URL keeping query string", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("see https://example.com/a?b=1&c=2 ok");
  assert.ok(out.includes("[https://example.com/a?b=1&c=2]"), out);
});

test("skips lines that already contain markdown links", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("see [build](dist/foo.exe) end");
  assert.equal(out, "see [build](dist/foo.exe) end");
});

test("trims trailing comma from linked path", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown(WB`go to C:\tmp\x.txt, then`);
  assert.ok(out.includes(WB`[C:\tmp\x.txt](file:///C:/tmp/x.txt)`), out);
  assert.ok(out.endsWith(", then"));
});

test("bare file:// URL keeps its href and encodes spaces", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("open file:///C:/Users/me/file.txt please");
  assert.ok(out.includes("[file:///C:/Users/me/file.txt](file:///C:/Users/me/file.txt)"), out);
});

test("sanitize schema keeps file: hrefs (otherwise links render dead)", async () => {
  const { markdownSanitizeSchema } = await loadSubject();
  const hrefProtocols = markdownSanitizeSchema.protocols?.href ?? [];
  assert.ok(hrefProtocols.includes("file"), JSON.stringify(hrefProtocols));
  assert.ok(hrefProtocols.includes("https"));
});

test("does not autolink bare drive letter without file (C:\\ only)", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("root is C:\\ or C:/");
  assert.ok(!out.includes("]["), out);
});

test("URL containing $& keeps text and href intact (replacement-pattern safe)", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("open https://x.com/a$&b now");
  assert.ok(out.includes("[https://x.com/a$&b](https://x.com/a$&b)"), out);
});

test("protects inline code spans from autolinking", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("use `C:\\tmp\\x.txt` here and https://y.com now");
  assert.ok(out.includes("`C:\\tmp\\x.txt`"), out);
  assert.ok(out.includes("[https://y.com]"), out);
});

test("protects fenced code blocks from autolinking", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const md = ["```text", "https://example.com/x", "C:\\tmp\\y.exe", "```", "then https://z.org"].join("\n");
  const out = autolinkPathsInMarkdown(md);
  assert.ok(out.includes("[https://z.org]"), out);
  assert.ok(!out.includes("[https://example.com/x]"), out);
});

test("autolinks UNC path to file://server/share form", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const input =
    "open " +
    String.fromCharCode(92, 92) +
    "server" +
    String.fromCharCode(92) +
    "share" +
    String.fromCharCode(92) +
    "dir" +
    String.fromCharCode(92) +
    "report.docx please";
  const out = autolinkPathsInMarkdown(input);
  assert.ok(out.includes("](file://server/share/dir/report.docx)"), out);
});

test("bare % in file:// URL is encoded, valid escapes are preserved", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const out = autolinkPathsInMarkdown("file:///C:/100%done.txt and file:///C:/a%20b.txt");
  assert.ok(out.includes("100%25done.txt"), out);
  assert.ok(out.includes("a%20b.txt"), out);
});

test("autolinks Windows path with unicode and spaces", async () => {
  const { autolinkPathsInMarkdown } = await loadSubject();
  const bs = String.fromCharCode(92);
  const input = "файл C:" + bs + "Users" + bs + "Анарки" + bs + "мои документы" + bs + "отчёт.docx тут";
  const out = autolinkPathsInMarkdown(input);
  assert.ok(out.includes("file:///C:/Users/Анарки/мои%20документы/отчёт.docx"), out);
});
