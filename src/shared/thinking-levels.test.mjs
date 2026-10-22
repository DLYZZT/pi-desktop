import assert from "node:assert/strict";
import test from "node:test";
import { stripThinkingSuffix, thinkingMenuLevels, configuredThinkingLevels } from "./thinking-levels.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

test("max is a distinct, capability-gated reasoning choice", () => {
  assert.deepEqual(thinkingMenuLevels(["off", "high", "xhigh", "max"]), ["auto", "off", "high", "xhigh", "max"]);
  assert.deepEqual(thinkingMenuLevels(["off", "high"]), ["auto", "off", "high"]);
  assert.ok(!thinkingMenuLevels().includes("max"));
  assert.equal(stripThinkingSuffix("openai/model:max"), "openai/model");
  assert.equal(stripThinkingSuffix("local/model:8b"), "local/model:8b");
});

test("settings preview matches SDK capabilities for partial, disabled, and explicit extended mappings", () => {
  for (const reasoning of [true, false])
    for (const thinkingLevelMap of [
      undefined,
      {},
      { minimal: "max" },
      { xhigh: "max", max: "max" },
      { off: null, low: null, xhigh: null, max: "max" },
    ]) {
      assert.deepEqual(
        configuredThinkingLevels(reasoning, thinkingLevelMap),
        getSupportedThinkingLevels({ reasoning, thinkingLevelMap }),
      );
    }
  assert.deepEqual(configuredThinkingLevels(true, { minimal: "max" }), ["off", "minimal", "low", "medium", "high"]);
});
