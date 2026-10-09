import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

test("1.1.0 catalogs keep chat selection separate from images and classifiers", async () => {
  for (const provider of ["openai", "azure", "openai-codex"]) {
    assert.equal(getModel(provider, "gpt-6.1-sol")?.contextWindow, 272_000);
  }
  assert.equal(getModel("azure", "gpt-6.1-sol")?.api, "azure-openai-responses");
  assert.equal(getModel("azure", "deepseek-v4-pro")?.api, "openai-completions");
  assert.equal(getModel("azure-openai-responses", "gpt-6.1-sol"), undefined);
  const sonnet = getModel("anthropic", "claude-sonnet-5-5");
  assert.equal(sonnet?.contextWindow, 1_000_000);
  assert.equal(sonnet?.reasoning, true);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      async modify() {
        throw new Error("Read-only fixture");
      },
      async delete() {
        throw new Error("Read-only fixture");
      },
    },
  });
  assert.ok(runtime.getModels().every((model) => (model.type ?? "chat") === "chat"));
  assert.ok(runtime.getAllModels().some((model) => model.type === "image"));
  assert.ok(runtime.getAllModels().some((model) => model.type === "classifier"));
  assert.ok(runtime.getProvider("openai").auth.apiKey);
  assert.ok(runtime.getProvider("openai").auth.oauth);
});

test("ChatGPT request trimming depends on both the credential and the exact OpenAI endpoint", async () => {
  const model = getModel("openai", "gpt-6.1-sol");
  for (const [apiKey, baseUrl, trimmed] of [
    ["subscription-fixture-token", "https://api.openai.com/v1", true],
    ["sk-api-fixture-key", "https://api.openai.com/v1", false],
    ["subscription-fixture-token", "https://gateway.example/v1", false],
  ]) {
    let payload;
    await stream(
      { ...model, baseUrl },
      { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
      {
        apiKey,
        maxTokens: 32,
        temperature: 0.1,
        onPayload(value) {
          payload = structuredClone(value);
          throw new Error("Captured before network");
        },
      },
    ).result();
    assert.ok(payload);
    assert.equal(payload.max_output_tokens, trimmed ? undefined : 32);
    assert.equal(payload.temperature, trimmed ? undefined : 0.1);
  }
});

test("runtime probe executes OpenAI OAuth and MCP lazy imports without user storage or login", async () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const { probePiRuntimeModules } = await importTestBundle("pi-110-runtime-probe", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/pi-runtime-probe.ts"],
  });
  assert.deepEqual(await probePiRuntimeModules(), { piVersion: "1.1.0", openaiOAuthLoaded: true, mcpLoaded: true });
});

test("Haiku 5.5 supports max while OpenAI decision availability follows the credential type", async () => {
  assert.ok(getSupportedThinkingLevels(getModel("anthropic", "claude-haiku-5-5")).includes("max"));
  for (const credential of [
    { type: "api_key", key: "sk-offline-fixture" },
    { type: "oauth", access: "offline-subscription", refresh: "offline-refresh", expires: Date.now() + 3600000 },
  ]) {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      credentials: {
        async read(provider) {
          return provider === "openai" ? credential : undefined;
        },
        async list() {
          return [{ providerId: "openai", type: credential.type }];
        },
        async modify() {
          throw new Error("read-only fixture");
        },
        async delete() {
          throw new Error("read-only fixture");
        },
      },
    });
    const available = await runtime.getAvailableOfType("classifier", "openai");
    assert.equal(
      available.some((model) => model.id === "gpt-6-luna"),
      credential.type === "api_key",
    );
    assert.ok(runtime.getModels().every((model) => (model.type ?? "chat") === "chat"));
  }
});
