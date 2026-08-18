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

test("cockpit keeps the original session info dropdown available without ChatWindow stats", () => {
  assert.match(source, /showChat\s*&&\s*\(selectedSession\s*\|\|\s*sessionStats\s*\|\|\s*contextUsage\)/);
  assert.match(source, /sessionStats\s*\?\s*\([\s\S]*?\)\s*:\s*selectedSession\s*\?/);
  assert.match(source, /label:\s*t\("sessionId",\s*"ID"\),\s*value:\s*selectedSession\.id/);
  assert.match(source, /label:\s*t\("workingDirectory",\s*"Working directory"\),\s*value:\s*selectedSession\.cwd/);
});
