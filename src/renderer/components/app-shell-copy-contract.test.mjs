import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("session clipboard rejection is consumed and exposed as local alert feedback", () => {
  assert.match(source, /copyText\(value\)[\s\S]*?\.catch\(\(\) => \{/);
  assert.match(source, /setSessionCopyFeedback\(\{ field, status: "error" \}\)/);
  assert.match(source, /sessionCopyFeedback\?\.status === "error"/);
  assert.match(source, /<div role="alert"/);
});
