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
