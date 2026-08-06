import assert from "node:assert/strict";
import test from "node:test";
import { MAX_HIGHLIGHT_CODE_BYTES, shouldHighlightCode } from "./code-highlight-policy.ts";

test("large code blocks skip syntax highlighting using UTF-8 byte size", () => {
  assert.equal(shouldHighlightCode("a".repeat(MAX_HIGHLIGHT_CODE_BYTES)), true);
  assert.equal(shouldHighlightCode("a".repeat(MAX_HIGHLIGHT_CODE_BYTES + 1)), false);
  assert.equal(shouldHighlightCode("中".repeat(Math.ceil(MAX_HIGHLIGHT_CODE_BYTES / 3))), false);
});
