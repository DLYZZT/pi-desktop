import assert from "node:assert/strict";
import test from "node:test";

import { buildToolMessageIndex } from "./tool-message-index.ts";

test("tool results and durations are indexed once for only their owning assistant", () => {
  const first = {
    role: "assistant",
    timestamp: 1_000,
    content: [
      { type: "toolCall", toolCallId: "call-a", toolName: "read", input: {} },
      { type: "toolCall", toolCallId: "missing", toolName: "read", input: {} },
    ],
  };
  const second = {
    role: "assistant",
    timestamp: 3_000,
    content: [{ type: "toolCall", toolCallId: "call-b", toolName: "write", input: {} }],
  };
  const resultA = { role: "toolResult", toolCallId: "call-a", timestamp: 2_600, content: [] };
  const resultB = { role: "toolResult", toolCallId: "call-b", timestamp: 5_200, content: [] };

  const index = buildToolMessageIndex([first, resultA, second, resultB]);

  assert.deepEqual([...index.get(first).results.keys()], ["call-a"]);
  assert.equal(index.get(first).durations.get("call-a"), 2);
  assert.deepEqual([...index.get(second).results.keys()], ["call-b"]);
  assert.equal(index.get(second).durations.get("call-b"), 2);
});

test("unrelated appended messages reuse tool maps and changed results replace only their owner", () => {
  const first = { role: "assistant", timestamp: 1000, content: [{ type: "toolCall", toolCallId: "a" }] };
  const second = { role: "assistant", timestamp: 2000, content: [{ type: "toolCall", toolCallId: "b" }] };
  const resultA = { role: "toolResult", toolCallId: "a", timestamp: 3000, content: [] };
  const resultB = { role: "toolResult", toolCallId: "b", timestamp: 4000, content: [] };
  const messages = [first, resultA, second, resultB];
  const before = buildToolMessageIndex(messages);
  const appended = buildToolMessageIndex([...messages, { role: "user", content: "unrelated" }], before);
  assert.equal(appended.get(first), before.get(first));
  assert.equal(appended.get(second), before.get(second));
  const correctedB = { ...resultB, timestamp: 5000, content: [{ type: "text", text: "corrected" }] };
  const corrected = buildToolMessageIndex([first, resultA, second, correctedB], appended);
  assert.equal(corrected.get(first), before.get(first));
  assert.notEqual(corrected.get(second), before.get(second));
  assert.equal(corrected.get(second).results.get("b"), correctedB);
  assert.equal(corrected.get(second).durations.get("b"), 3);
  const removed = buildToolMessageIndex([first, resultA, second], corrected);
  assert.equal(removed.get(second).results.size, 0);
});
