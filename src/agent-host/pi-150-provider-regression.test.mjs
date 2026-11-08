import assert from "node:assert/strict";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { buildSessionStats } from "./session-stats.ts";
import { normalizeToolCalls } from "../shared/normalize.ts";

test("Terra keeps provider-specific context windows and supports turning thinking off", () => {
  for (const [provider, contextWindow] of [
    ["openai", 272000],
    ["azure", 272000],
    ["openai-codex", 500000],
  ]) {
    const model = getModel(provider, "gpt-6.1-terra");
    assert.ok(model, provider);
    assert.equal(model.contextWindow, contextWindow);
    assert.ok(getSupportedThinkingLevels(model).includes("off"));
  }
  assert.equal(getModel("openai", "gpt-realtime-2.1"), undefined);
});

test("fragmented large tool calls preserve final arguments, response model and OpenRouter billed totals", async () => {
  const value = "中文代码\n".repeat(25000);
  const argumentsText = JSON.stringify({ text: value });
  const events = [];
  for (let start = 0; start < argumentsText.length; start += 1024) {
    events.push({
      id: "response",
      model: "actual-response-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                ...(start === 0 ? { id: "tool-call", type: "function" } : {}),
                function: {
                  ...(start === 0 ? { name: "fixture" } : {}),
                  arguments: argumentsText.slice(start, start + 1024),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  events.push({
    id: "response",
    model: "actual-response-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cost: 0.125,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.25 },
    },
  });
  const model = {
    id: "requested-model",
    name: "Fixture",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  const fetch = async () =>
    new globalThis.Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  const result = await stream(
    model,
    { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
    { apiKey: "FIXTURE", fetch },
  ).result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.deepEqual(result.content[0].arguments, { text: value });
  assert.equal(result.responseModel, "actual-response-model");
  assert.equal(result.usage.cost.total, 0.375);
  assert.equal(result.usage.cost.totalFromProvider, true);
  assert.notEqual(result.usage.cost.total, result.usage.cost.input + result.usage.cost.output);
  const displayed = normalizeToolCalls(result);
  assert.equal(displayed.responseModel, result.responseModel);
  assert.equal(displayed.usage.cost.totalFromProvider, true);
  const statistics = buildSessionStats([{ type: "message", id: "entry", parentId: null, message: result }], {
    sessionId: "fixture",
  });
  assert.equal(statistics.cost, 0.375);
  assert.equal(statistics.modelUsage[0].model, "requested-model");
});
