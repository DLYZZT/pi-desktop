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
