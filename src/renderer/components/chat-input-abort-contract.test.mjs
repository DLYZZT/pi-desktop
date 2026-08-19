import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("ChatInput Escape aborts a running agent after menus close", () => {
  assert.match(inputSource, /if \(e\.key === "Escape" && isStreaming && !isComposing\)/);
  const escapeIndex = inputSource.indexOf('if (e.key === "Escape" && isStreaming && !isComposing)');
  assert.notEqual(escapeIndex, -1);
  const block = inputSource.slice(escapeIndex, escapeIndex + 180);
  assert.match(block, /onAbort\(\)/);
});

test("ChatInput mid-turn Ctrl+Enter steers now and Enter queues", () => {
  assert.match(inputSource, /if \(e\.ctrlKey && onSteer\) void sendQueued\("steer"\)/);
  assert.match(inputSource, /else if \(!e\.ctrlKey && onFollowUp\) void sendQueued\("followup"\)/);
});

test("ChatInput Stop fires abort on pointer down so a remount cannot swallow the click", () => {
  const stopIndex = inputSource.indexOf('title={t("stopAgent", "Stop agent")}');
  assert.notEqual(stopIndex, -1);
  const block = inputSource.slice(Math.max(0, stopIndex - 420), stopIndex);
  assert.match(block, /onPointerDown=/);
  assert.match(block, /onAbort\(\)/);
});
