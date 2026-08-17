import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("handleAbort latches before session id exists and waits for ensureNewSession", () => {
  const abortIndex = hookSource.indexOf("const handleAbort = useCallback(() => {");
  assert.notEqual(abortIndex, -1);
  const block = hookSource.slice(abortIndex, abortIndex + 700);
  assert.match(block, /abortRequestedRef\.current = true/);
  assert.match(block, /setAgentRunning\(false\)/);
  assert.match(block, /sessionIdRef\.current \?\? \(await ensuringNewSessionRef\.current\)/);
  assert.match(block, /sendAgentCommand\(sid, \{ type: "abort" \}\)/);
});

test("handleSend checks the abort latch before the prompt leaves", () => {
  assert.match(hookSource, /if \(abortRequestedRef\.current\) break/);
  assert.match(hookSource, /abortRequestedRef\.current = false/);
  assert.match(hookSource, /const throwIfSendAborted = async \(sid: string \| null\) => \{/);
  assert.equal((hookSource.match(/await throwIfSendAborted\(/g) ?? []).length >= 4, true);
  const abortErrorIndex = hookSource.indexOf('e instanceof Error && e.name === "AbortError"');
  assert.notEqual(abortErrorIndex, -1);
  const catchBlock = hookSource.slice(abortErrorIndex, abortErrorIndex + 900);
  assert.match(catchBlock, /if \(!aborted\) \{\s*addNotice\(/);
});
