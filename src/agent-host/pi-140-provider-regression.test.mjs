import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

const credentials = (provider, key) => ({
  read: async (id) => (id === provider ? { type: "api_key", key } : undefined),
  list: async () => [{ providerId: provider, type: "api_key" }],
  modify: async () => {
    throw new Error("read only");
  },
  delete: async () => {},
});

async function kimiRequest(t, override) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-140-kimi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsPath = path.join(root, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: override ? { "kimi-coding": override } : {} }));
  const runtime = await ModelRuntime.create({
    modelsPath,
    credentials: credentials("kimi-coding", "KIMI_FIXTURE_KEY"),
    refreshOnCreate: false,
  });
  const model = runtime.getModel("kimi-coding", "kimi-for-coding");
  assert.ok(model);
  let request;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    request = { url: String(input), authorization: new globalThis.Headers(init.headers).get("authorization") };
    return new globalThis.Response("upstream fixture failure", { status: 400 });
  });
  await runtime.completeSimple(
    model,
    { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
    {
      maxRetries: 0,
    },
  );
  t.mock.restoreAll();
  return { model, request };
}

test("Kimi Code uses Chat Completions at the /v1 default and keeps base URL overrides verbatim", async (t) => {
  for (const model of getModels("kimi-coding")) {
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "https://api.kimi.com/coding/v1");
  }

  const builtIn = await kimiRequest(t);
  assert.equal(builtIn.request.url, "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(builtIn.request.authorization, "Bearer KIMI_FIXTURE_KEY");

  // A pre-1.3 override without /v1 is not repaired; Desktop reports it as a compatibility warning.
  const legacy = await kimiRequest(t, { baseUrl: "https://api.kimi.com/coding" });
  assert.equal(legacy.request.url, "https://api.kimi.com/coding/chat/completions");

  const proxy = await kimiRequest(t, { baseUrl: "https://proxy.fixture.invalid/kimi/v1" });
  assert.equal(proxy.model.api, "openai-completions");
  assert.equal(proxy.request.url, "https://proxy.fixture.invalid/kimi/v1/chat/completions");
  assert.equal(proxy.request.authorization, "Bearer KIMI_FIXTURE_KEY");
});

test("1.3/1.4 catalog changes that affect stored Desktop selections", () => {
  // Thinking levels used by manual selection and Auto fast/strong settings.
  for (const id of ["claude-haiku-5-5", "claude-opus-5"]) {
    const model = getModel("anthropic", id);
    assert.ok(model, id);
    assert.ok(getSupportedThinkingLevels(model).includes("off"), id);
  }
  // Codex no longer lists models that always fail for ChatGPT accounts.
  for (const id of ["gpt-5.5", "gpt-5.3-codex-spark"]) assert.equal(getModel("openai-codex", id), undefined, id);
});

test("switching models drops foreign thinking from the provider projection without mutating history", () => {
  const target = getModel("anthropic", "claude-sonnet-5-5");
  const original = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "fast model reasoning" },
      { type: "text", text: "visible answer" },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6.1-sol",
    stopReason: "stop",
    timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  };
  const snapshot = structuredClone(original);
  const [projected] = transformMessages([original], target);
  assert.deepEqual(projected.content, [{ type: "text", text: "visible answer" }]);
  assert.deepEqual(original, snapshot);

  const same = { ...original, api: target.api, provider: target.provider, model: target.id };
  assert.equal(transformMessages([same], target)[0].content[0].type, "thinking");
});
