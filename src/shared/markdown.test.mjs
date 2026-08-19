import assert from "node:assert/strict";
import test from "node:test";

import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  linkifyLocalFileText,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  remarkLocalFileLinks,
} from "./markdown.ts";

test("Markdown plugins preserve GFM/math, add AST path links, and sanitize raw HTML", () => {
  assert.deepEqual(markdownRemarkPlugins, [remarkGfm, remarkMath, remarkLocalFileLinks]);
  assert.equal(markdownRehypePlugins[0], rehypeRaw);
  assert.equal(markdownRehypePlugins[1][0], rehypeSanitize);
  assert.equal(markdownRehypePlugins[2][0], rehypeKatex);
  assert.deepEqual(markdownRehypePlugins[2][1], { throwOnError: false, strict: false });
  const schema = markdownRehypePlugins[1][1];
  assert.deepEqual(schema.strip.slice(-4), ["iframe", "object", "style", "form"]);
  assert.ok(schema.protocols.href.includes("file"));
});

function linkTargets(value) {
  return linkifyLocalFileText(value)
    .filter((node) => node.type === "link")
    .map((node) => [node.children[0].value, node.url]);
}

test("links POSIX, Windows, UNC, and canonical file URLs from ordinary text nodes", () => {
  assert.deepEqual(linkTargets("at /home/me/src/main.ts:10 now"), [
    ["/home/me/src/main.ts:10", "file:///home/me/src/main.ts:10"],
  ]);
  assert.deepEqual(linkTargets(String.raw`at C:\Users\me\Pi Desktop.exe now`), [
    [String.raw`C:\Users\me\Pi Desktop.exe`, "file:///C:/Users/me/Pi%20Desktop.exe"],
  ]);
  assert.deepEqual(linkTargets(String.raw`at \\server\share\report.docx now`), [
    [String.raw`\\server\share\report.docx`, "file://server/share/report.docx"],
  ]);
  assert.deepEqual(linkTargets("at file:///tmp/a%20b.txt now"), [["file:///tmp/a%20b.txt", "file:///tmp/a%20b.txt"]]);
});

test("links multiple paths while preserving trailing punctuation and @ project references", () => {
  const nodes = linkifyLocalFileText("@src/main.ts then /tmp/a.txt, and /tmp/b.txt.");
  assert.equal(
    nodes.map((node) => (node.type === "text" ? node.value : node.children[0].value)).join(""),
    "@src/main.ts then /tmp/a.txt, and /tmp/b.txt.",
  );
  assert.deepEqual(
    nodes.filter((node) => node.type === "link").map((node) => node.url),
    ["file:///tmp/a.txt", "file:///tmp/b.txt"],
  );
});

test("separates adjacent local paths joined by English or Chinese prose", () => {
  assert.deepEqual(linkTargets("compare /tmp/a.txt 和 /tmp/b.txt"), [
    ["/tmp/a.txt", "file:///tmp/a.txt"],
    ["/tmp/b.txt", "file:///tmp/b.txt"],
  ]);
  assert.deepEqual(linkTargets("compare /tmp/a.txt and /tmp/b.txt"), [
    ["/tmp/a.txt", "file:///tmp/a.txt"],
    ["/tmp/b.txt", "file:///tmp/b.txt"],
  ]);
});

test("links local filenames containing spaces and absolute directories without extensions", () => {
  assert.deepEqual(linkTargets("open /tmp/a b.txt now"), [["/tmp/a b.txt", "file:///tmp/a%20b.txt"]]);
  assert.deepEqual(linkTargets("open /tmp/pi-desktop-ui-test.Xu9qVi/repo/folder now"), [
    ["/tmp/pi-desktop-ui-test.Xu9qVi/repo/folder", "file:///tmp/pi-desktop-ui-test.Xu9qVi/repo/folder"],
  ]);
});

test("AST transform skips existing links, images, code, inline code, HTML, and math", () => {
  const tree = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "/tmp/plain.txt" }] },
      { type: "link", url: "https://example.com", children: [{ type: "text", value: "/tmp/link.txt" }] },
      { type: "image", url: "/tmp/image.png", children: [] },
      { type: "code", value: "/tmp/code.txt" },
      { type: "inlineCode", value: "/tmp/inline.txt" },
      { type: "html", value: '<a href="https://example.com/x">x</a>' },
      { type: "math", value: "/tmp/math.txt" },
    ],
  };
  remarkLocalFileLinks()(tree);
  assert.equal(tree.children[0].children[0].type, "link");
  assert.equal(tree.children[1].children[0].type, "text");
  assert.equal(tree.children[1].children[0].value, "/tmp/link.txt");
  assert.equal(tree.children[5].value, '<a href="https://example.com/x">x</a>');
});

test("does not treat web URLs, relative @ references, or bare drive roots as local paths", () => {
  assert.deepEqual(linkTargets("https://example.com/x @src/main.ts C:\\"), []);
});
