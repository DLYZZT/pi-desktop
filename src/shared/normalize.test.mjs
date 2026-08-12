import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolCalls } from "./normalize.ts";

test("assistant tool calls normalize legacy ids, names, arguments, and malformed inputs", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", toolCallId: 1, toolName: null, input: [] },
      { type: "text", text: "unchanged" },
    ],
  };
  const normalized = normalizeToolCalls(message);
  assert.deepEqual(normalized.content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "a" },
  });
  assert.deepEqual(normalized.content[1], { type: "toolCall", toolCallId: "", toolName: "", input: {} });
  assert.equal(normalized.content[2], message.content[2]);
  assert.notEqual(normalized, message);
});

test("non-assistant and scalar assistant messages retain identity", () => {
  const user = { role: "user", content: "hello" };
  const assistant = { role: "assistant", content: "hello" };
  assert.equal(normalizeToolCalls(user), user);
  assert.equal(normalizeToolCalls(assistant), assistant);
});
