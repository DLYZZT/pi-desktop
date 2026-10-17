import assert from "node:assert/strict";
import test from "node:test";
import { parseCodemodeSource } from "@earendil-works/pi-codemode";
import { serializeConversation } from "@earendil-works/pi-coding-agent";

test("1.2.0 rejects misplaced Codemode options before executing the script", () => {
  const parsed = parseCodemodeSource('// @options: {"timeout_ms": 50}\ntext("ok")');
  assert.equal(parsed.options.timeoutMs, 50);
  assert.throws(() => parseCodemodeSource('text("MUST_NOT_RUN");\n// @options: {"timeout_ms": 50}'), /first line/i);
});

test("summary serialization omits thinking without mutating the original transcript", () => {
  const messages = [
    { role: "user", content: "Question", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "THOUGHT_NOT_IN_SUMMARY", thinkingSignature: "private" },
        { type: "text", text: "FINAL_ANSWER" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "fixture",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
  const original = JSON.stringify(messages);
  const summary = serializeConversation(messages);
  assert.match(summary, /FINAL_ANSWER/);
  assert.doesNotMatch(summary, /THOUGHT_NOT_IN_SUMMARY/);
  assert.equal(JSON.stringify(messages), original);
});
