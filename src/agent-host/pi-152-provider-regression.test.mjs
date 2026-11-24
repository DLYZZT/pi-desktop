import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAi } from "@earendil-works/pi-ai/api/openai-completions";
import { getModel } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const fixtureModel = {
  id: "fixture-model",
  name: "Fixture",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost,
};
const user = (content) => ({ role: "user", content, timestamp: 1 });
const sse = (body) => new globalThis.Response(body, { headers: { "content-type": "text/event-stream" } });

test("OpenAI-compatible requests omit tools after revocation unless the model opts into the empty array", async () => {
  const model = {
    ...fixtureModel,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
  };
  const history = [
    user("Use the lookup tool"),
    {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call-one", name: "lookup", arguments: {} }],
      usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
    },
    {
      role: "toolResult",
      toolCallId: "call-one",
      toolName: "lookup",
      content: [{ type: "text", text: "found" }],
      isError: false,
      timestamp: 3,
    },
    user("Continue without tools"),
  ];
  const requests = [];
  const fetch = async (_input, init) => {
    requests.push(JSON.parse(init.body));
    const event = {
      id: "completion",
      model: model.id,
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    };
    return sse("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n");
  };
  const compat = { requiresToolsWithToolHistory: true };
  for (const [messages, override] of [
    [history, undefined],
    [history, compat],
    [[user("Hello")], compat],
  ]) {
    const result = await streamOpenAi({ ...model, compat: override }, normalizeContext({ messages, tools: [] }), {
      apiKey: "fixture",
      fetch,
    }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
  assert.ok(requests[0].messages.some((message) => message.role === "tool"));
  assert.equal(Object.hasOwn(requests[0], "tools"), false);
  assert.deepEqual(requests[1].tools, []);
  assert.equal(Object.hasOwn(requests[2], "tools"), false);
});

test("Anthropic continues a thread with new messages and resends the full conversation after history changes", async () => {
  const model = {
    ...fixtureModel,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  };
  const requests = [];
  const fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    const id = "msg-" + requests.push(body);
    const events = [
      { type: "message_start", message: { id, model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return sse(events.map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""));
  };
  const options = { apiKey: "fixture", cacheRetention: "short", sessionId: "pi-152-thread", fetch };
  const messages = [];
  for (const question of ["First question", "Follow-up", "Question on a different branch"]) {
    if (messages.length === 4) messages[0] = user("Edited first question");
    messages.push(user(question));
    const result = await streamAnthropic(
      model,
      normalizeContext({ systemPrompt: "Fixture", messages }),
      options,
    ).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    messages.push(result);
  }
  const [first, second, third] = requests;
  assert.deepEqual(first.thread, { type: "create" });
  assert.deepEqual(second.thread, { type: "continue", previous_message_id: "msg-1" });
  assert.equal(second.messages.length, 1);
  assert.deepEqual(third.thread, { type: "create" });
  assert.equal(third.messages.length, 5);
});

test("Azure preserves the long-context price tier and Copilot keeps its classifier out of the chat catalog", async () => {
  const azure = getModel("azure", "gpt-6.1-sol");
  assert.equal(azure.contextWindow, 1_050_000);
  assert.deepEqual(azure.cost.tiers, [
    { inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  ]);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [] },
  });
  const isCopilotDecision = ({ provider, id }) => provider === "github-copilot" && id === "microsoft-decision-1";
  assert.equal(runtime.getAllModels().find(isCopilotDecision)?.type, "classifier");
  assert.equal(runtime.getModels().some(isCopilotDecision), false);
});
