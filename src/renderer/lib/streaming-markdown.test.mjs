import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenFenceTail, resolveStreamingDefinitions, splitStreamingMarkdown } from "./streaming-markdown.ts";

function assertLossless(source) {
  const blocks = splitStreamingMarkdown(source);
  assert.equal(blocks.join(""), source);
  return blocks;
}

test("splits paragraphs and headings at blank lines without losing text", () => {
  assert.deepEqual(assertLossless("# A\n\nfirst\nstill first\n\n\nsecond"), [
    "# A\n\n",
    "first\nstill first\n\n\n",
    "second",
  ]);
  assert.deepEqual(assertLossless(""), [""]);
  assert.deepEqual(assertLossless("\n\nonly"), ["\n\nonly"]);
  assert.deepEqual(assertLossless("a\r\n\r\nb"), ["a\r\n\r\n", "b"]);
});

test("never splits inside fenced code, including indented and longer fences", () => {
  assert.deepEqual(assertLossless("```js\na\n\nb\n```\n\nafter"), ["```js\na\n\nb\n```\n", "\nafter"]);
  assert.deepEqual(assertLossless("````md\n```\n\nx\n```\n\ny\n````\n\nafter"), [
    "````md\n```\n\nx\n```\n\ny\n````\n",
    "\nafter",
  ]);
  assert.deepEqual(assertLossless("text\n\n~~~\nopen\n\nstill code"), ["text\n\n", "~~~\nopen\n\nstill code"]);
  // A backtick fence whose info string contains a backtick is inline code, not a fence.
  assert.deepEqual(assertLossless("```a`b\n\nnext"), ["```a`b\n\n", "next"]);
});

test("keeps lists, quotes, indented code, tables and definitions with their container", () => {
  for (const source of [
    "- a\n\n- b\n\n  continued",
    "1. a\n\n2. b",
    "> quote\n\n> more",
    "para\n\n    indented code",
    "| a |\n| - |\n\n| b |",
    "see [ref]\n\n[ref]: https://example.com",
    "note[^1]\n\n[^1]: footnote",
  ]) {
    assert.deepEqual(assertLossless(source), [source]);
  }
  assert.deepEqual(assertLossless("- a\n- b\n\nparagraph"), ["- a\n- b\n\n", "paragraph"]);
});

test("does not split inside display math or after a raw HTML block starts", () => {
  assert.deepEqual(assertLossless("$$\na\n\nb\n$$\n\nafter"), ["$$\na\n\nb\n$$\n\n", "after"]);
  assert.deepEqual(assertLossless("$$x$$\n\nafter"), ["$$x$$\n\n", "after"]);
  assert.deepEqual(assertLossless("before\n\n<details>\n\ninner\n\n</details>\n\nafter"), [
    "before\n\n",
    "<details>\n\ninner\n\n</details>\n\nafter",
  ]);
  assert.deepEqual(assertLossless("inline <br> html\n\nafter"), ["inline <br> html\n\n", "after"]);
});

test("recognises only an unfinished top-level fence as a code tail", () => {
  assert.deepEqual(parseOpenFenceTail("```TS\nconst a = 1;\n\nconst b = 2;\n"), {
    lang: "ts",
    code: "const a = 1;\n\nconst b = 2;",
  });
  assert.deepEqual(parseOpenFenceTail("~~~\r\nline\r\n"), { lang: "", code: "line" });
  assert.equal(parseOpenFenceTail("```ts"), null);
  assert.equal(parseOpenFenceTail("```ts\ncode\n```\n"), null);
  assert.equal(parseOpenFenceTail("```ts\ncode\n```\ntrailing"), null);
  assert.equal(parseOpenFenceTail("text\n```ts\ncode"), null);
  assert.equal(parseOpenFenceTail("  ```ts\ncode"), null);
});

test("an unindented fence is its own block and is finished as soon as it closes", () => {
  // The closed fence never stays in the unfinished tail, with or without a following blank line.
  assert.deepEqual(assertLossless("```js\ncode\n```\n"), ["```js\ncode\n```\n", ""]);
  assert.deepEqual(assertLossless("```js\ncode\n```"), ["```js\ncode\n```", ""]);
  assert.deepEqual(assertLossless("```js\ncode\n```\ntext right after"), ["```js\ncode\n```\n", "text right after"]);
  assert.deepEqual(assertLossless("intro:\n```js\ncode\n```\n- item"), ["intro:\n", "```js\ncode\n```\n", "- item"]);
  assert.deepEqual(assertLossless("- item\n```js\ncode"), ["- item\n", "```js\ncode"]);
  // An indented fence may belong to a list item, so it stays with its container.
  assert.deepEqual(assertLossless("- item\n\n  ```js\n  code\n  ```\n\n  more"), [
    "- item\n\n  ```js\n  code\n  ```\n\n  more",
  ]);
  assert.deepEqual(assertLossless("<div>\n```js\ncode\n```\n"), ["<div>\n```js\ncode\n```\n"]);
});

test("shares link definitions with the other blocks that reference them", () => {
  const blocks = splitStreamingMarkdown(
    "See [the guide][Guide] and [other].\n\nPlain paragraph.\n\n[guide]: https://example.com/guide\n[other]: <https://example.com/o>\n[^1]: footnote\n\nTail [guide]",
  );
  assert.equal(blocks.length, 3);
  assert.deepEqual(resolveStreamingDefinitions(blocks), [
    "\n\n[guide]: https://example.com/guide\n[other]: <https://example.com/o>\n",
    "",
    "\n\n[guide]: https://example.com/guide\n",
  ]);
  assert.deepEqual(resolveStreamingDefinitions(["a [x]\n\n", "b"]), ["", ""]);
  // Definitions inside code, or interrupting a paragraph, are not definitions.
  assert.deepEqual(resolveStreamingDefinitions(["use [x]\n\n", "```\n[x]: https://a.example\n```\n", ""]), [
    "",
    "",
    "",
  ]);
  assert.deepEqual(resolveStreamingDefinitions(["use [x]\n\n", "text\n[x]: https://a.example\n"]), ["", ""]);
  // Nothing is appended into an unfinished indented fence.
  assert.deepEqual(resolveStreamingDefinitions(["[x]: https://a.example\n\n", "- [x]\n\n  ```\n  [x]"]), ["", ""]);
});
