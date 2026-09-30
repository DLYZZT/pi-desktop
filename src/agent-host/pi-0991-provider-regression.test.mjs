import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";

test("0.99.1 catalogs keep chat selection separate from images and classifiers", async () => {
  for (const provider of ["openai", "azure-openai-responses", "openai-codex"]) {
    assert.equal(getModel(provider, "gpt-6.1-sol")?.contextWindow, 272_000);
  }
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
  const { probePiRuntimeModules } = await importTestBundle("pi-0991-runtime-probe", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/pi-runtime-probe.ts"],
  });
  assert.deepEqual(await probePiRuntimeModules(), { piVersion: "0.99.1", openaiOAuthLoaded: true, mcpLoaded: true });
});
