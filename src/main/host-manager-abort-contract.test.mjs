import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./host-manager.ts", import.meta.url), "utf8");

test("abortSession kills tracked bash/ssh from main before waiting on host", () => {
  const index = source.indexOf("abortSession(sessionId: string)");
  assert.notEqual(index, -1);
  const block = source.slice(index, index + 900);
  assert.match(block, /terminatePidTree/);
  assert.match(block, /interruptCommandDescendants/);
  assert.match(block, /session-abort/);
});
