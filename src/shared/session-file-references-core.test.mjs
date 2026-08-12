import assert from "node:assert/strict";
import test from "node:test";

import { isFilePathReferencedByEntries, isValidSessionId } from "./session-file-references-core.ts";

test("session ids require a complete UUID shape", () => {
  assert.equal(isValidSessionId("019ff6a4-2797-76d0-b75b-c852d46847e0"), true);
  for (const value of [null, "", "019ff6a4-2797-76d0-b75b-c852d46847e0-extra"]) {
    assert.equal(isValidSessionId(value), false);
  }
});

test("file references match exact nested, encoded, Windows, and line-suffixed paths", () => {
  const entries = [{ type: "message", nested: { content: ["file:///tmp/my%20file.ts:12", "C:\\repo\\src\\main.ts"] } }];
  assert.equal(isFilePathReferencedByEntries("/tmp/my file.ts", entries), true);
  assert.equal(isFilePathReferencedByEntries("C:/repo/src/main.ts", entries), true);
  assert.equal(isFilePathReferencedByEntries("/tmp/my file", entries), false);
  assert.equal(isFilePathReferencedByEntries("/tmp/my file.tsx", entries), false);
});
