import assert from "node:assert/strict";
import test from "node:test";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";

const { Request, Response } = globalThis;

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model = {
  id: "claude-fable-5-1",
  name: "Acceptance fixture",
  api: "anthropic-messages",
  provider: "acceptance",
  baseUrl: "http://127.0.0.1:9",
  reasoning: true,
  input: ["text"],
  cost,
  contextWindow: 200000,
  maxTokens: 2048,
  compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
};
const user = (content) => ({ role: "user", content, timestamp: 1 });
const historical = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "fixture reasoning", thinkingSignature: "fixture-signature-not-for-network" },
    { type: "text", text: "earlier answer" },
  ],
  api: model.api,
  provider: model.provider,
  model: model.id,
  providerThinkingLevel: "low",
  stopReason: "stop",
  timestamp: 2,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
};

function anthropicResponse(transformations = []) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "fixture",
        role: "assistant",
        model: model.id,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "RECOVERY_OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
      input_transformations: transformations,
    },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("managed thinking reconstructs historical effort and retains server drop-block recovery diagnostics", async () => {
  let payload, beta;
  const transforms = [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }];
  const result = await anthropic(
    model,
    { messages: [user("one"), historical, user("two")] },
    {
      apiKey: "fixture",
      effort: "high",
      thinkingEnabled: true,
      cacheRetention: "none",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        payload = await request.json();
        beta = request.headers.get("anthropic-beta");
        return anthropicResponse(transforms);
      },
    },
  ).result();
  assert.deepEqual(
    payload.messages.filter((entry) => entry.role === "system").map((entry) => entry.output_config.effort),
    ["low", "high"],
  );
  assert.equal(payload.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.match(beta, /thinking-binding-controls/);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.providerThinkingLevel, "high");
  assert.equal(
    result.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join(""),
    "RECOVERY_OK",
  );
  assert.deepEqual(result.diagnostics[0].details.transformations, transforms);
});

test("unsupported transport omits managed effort markers and binding controls", async () => {
  let payload;
  const result = await anthropic(
    { ...model, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: false } },
    { messages: [user("one")] },
    {
      apiKey: "fixture",
      effort: "low",
      thinkingEnabled: true,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        payload = await request.json();
        return anthropicResponse();
      },
    },
  ).result();
  assert.equal(
    payload.messages.some((entry) => entry.role === "system"),
    false,
  );
  assert.equal(payload.thinking.block_binding, undefined);
  assert.equal(result.providerThinkingLevel, undefined);
  assert.equal(result.stopReason, "stop");
});

test("vLLM priority and thinking budget reach the wire without changing model configuration", async () => {
  const configured = {
    ...model,
    id: "fixture",
    api: "openai-completions",
    compat: { thinkingFormat: "zai", vllmPriority: 10, thinkingTokenBudgetField: "thinking_budget" },
  };
  let payload;
  await completions(
    configured,
    { messages: [user("hello")] },
    {
      apiKey: "fixture",
      reasoning: "low",
      thinkingBudgets: { low: 128 },
      maxTokens: 2048,
      onPayload: (value) => {
        payload = value;
        throw new Error("captured before network");
      },
    },
  ).result();
  assert.equal(payload.priority, 10);
  assert.equal(payload.thinking_budget, 128);
  assert.equal(configured.compat.vllmPriority, 10);
});

test("Responses output-token compatibility flag controls the serialized cap", async () => {
  for (const supported of [true, false]) {
    let payload;
    await responses(
      {
        ...model,
        id: "fixture",
        api: "openai-responses",
        reasoning: false,
        compat: { supportsMaxOutputTokens: supported },
      },
      { messages: [user("hello")] },
      {
        apiKey: "fixture",
        maxTokens: 1024,
        onPayload: (value) => {
          payload = value;
          throw new Error("captured before network");
        },
      },
    ).result();
    assert.equal(payload.max_output_tokens, supported ? 1024 : undefined);
  }
});

test("NO_PROXY excludes root domains and descendants but not suffix lookalikes", () => {
  const env = {
    https_proxy: "http://127.0.0.1:9876",
    http_proxy: "http://127.0.0.1:9876",
    no_proxy: "example.test,.another.test,127.0.0.1:8317",
  };
  for (const host of ["example.test", "api.example.test", "another.test", "api.another.test"]) {
    assert.equal(resolveHttpProxyUrlForTarget(`https://${host}`, env), undefined);
  }
  assert.equal(resolveHttpProxyUrlForTarget("http://127.0.0.1:8317", env), undefined);
  assert.equal(resolveHttpProxyUrlForTarget("https://notexample.test", env).port, "9876");
  assert.equal(resolveHttpProxyUrlForTarget("http://127.0.0.1:8318", env).port, "9876");
});

test("Codex consumes a terminal SSE event without a final blank line", async () => {
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id: "fixture", role: "assistant", status: "in_progress", content: [] },
    },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: "TERMINAL_SSE_OK" },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "TERMINAL_SSE_OK" }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n");
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fixture`;
  const result = await codex(
    { ...model, api: "openai-codex-responses", id: "gpt-5.1-codex", provider: "openai-codex", compat: undefined },
    { messages: [user("hello")] },
    {
      apiKey: token,
      transport: "sse",
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    },
  ).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content.find((entry) => entry.type === "text").text, "TERMINAL_SSE_OK");
});

test("0.85 bundled model catalogs retain the corrected Qwen, Baseten and Fireworks capabilities", () => {
  assert.ok(getModel("qwen-token-plan-individual", "qwen3.8-flash"));
  const baseten = getModels("baseten").filter((entry) => /glm[- ]?5[.-]2/i.test(entry.id));
  assert.ok(baseten.length > 0);
  assert.ok(baseten.every((entry) => !entry.input.includes("image")));
  const fireworks = getModels("fireworks").filter((entry) => /glm[- ]?5/i.test(entry.id));
  assert.ok(fireworks.length > 0);
  assert.ok(fireworks.every((entry) => entry.api === "openai-completions"));
});
