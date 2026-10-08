import assert from "node:assert/strict";
import test from "node:test";
import { stripThinkingSuffix, thinkingMenuLevels } from "./thinking-levels.ts";

test("max is a distinct, capability-gated reasoning choice", () => {
  assert.deepEqual(thinkingMenuLevels(["off", "high", "xhigh", "max"]), ["auto", "off", "high", "xhigh", "max"]);
  assert.deepEqual(thinkingMenuLevels(["off", "high"]), ["auto", "off", "high"]);
  assert.ok(!thinkingMenuLevels().includes("max"));
  assert.equal(stripThinkingSuffix("openai/model:max"), "openai/model");
  assert.equal(stripThinkingSuffix("local/model:8b"), "local/model:8b");
});
