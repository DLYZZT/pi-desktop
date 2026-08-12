import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("initial model load reports non-abort failures without clearing cached models", () => {
  assert.match(source, /controller\.signal\.aborted \|\| \(e instanceof DOMException && e\.name === "AbortError"\)/);
  assert.match(source, /console\.error\("Failed to load model directory:", e\)/);
  assert.match(source, /modelListSizeRef\.current > 0/);
  assert.match(source, /Cached models remain available; retry from the model picker/);
  assert.match(source, /Retry from the model picker or check the Agent Host connection/);
  assert.doesNotMatch(
    source,
    /catch\(\(e\) => \{\s*if \(e instanceof DOMException && e\.name === "AbortError"\) return;\s*\}\)/,
  );
});
