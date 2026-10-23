import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDeferred } from "#test-timing";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { getSupportedThinkingLevels, envApiKeyAuth } from "@earendil-works/pi-ai";

test("catalogs keep chat selection separate from images and classifiers", async () => {
  // Since 1.3.0 Codex serves a 500K window; the API-key providers keep 272K.
  for (const [provider, contextWindow] of [
    ["openai", 272_000],
    ["azure", 272_000],
    ["openai-codex", 500_000],
  ]) {
    assert.equal(getModel(provider, "gpt-6.1-sol")?.contextWindow, contextWindow);
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

test("OpenRouter personalized catalogs use the configured endpoint and share the CLI cache across credentials", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-120-openrouter-"));
  const modelsPath = path.join(root, "models.json"),
    cache = path.join(root, "models-store.json");
  const previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { openrouter: { baseUrl: "https://region.fixture.invalid/v1" } } }),
  );
  const credentials = (key) => ({
    read: async (provider) => (provider === "openrouter" ? { type: "api_key", key } : undefined),
    list: async () => [{ providerId: "openrouter", type: "api_key" }],
    modify: async () => {
      throw new Error("read only");
    },
    delete: async () => {},
  });
  const runtime = (key) =>
    ModelRuntime.create({
      modelsPath,
      catalogBaseUrl: "https://catalog.fixture.invalid",
      credentials: credentials(key),
      refreshOnCreate: false,
    });
  const first = await runtime("KEY_A");
  const ids = first
    .getModels()
    .filter((model) => model.provider === "openrouter")
    .slice(0, 2)
    .map((model) => model.id);
  assert.equal(ids.length, 2);
  const requests = [];
  let status = 200,
    hold = false;
  const entered = createDeferred();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://catalog.fixture.invalid/")) return new globalThis.Response(null, { status: 404 });
    assert.equal(url, "https://region.fixture.invalid/v1/models/user");
    const authorization = new globalThis.Headers(init.headers).get("authorization");
    requests.push(authorization);
    if (hold) {
      entered.resolve();
      await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    if (status !== 200) return new globalThis.Response(null, { status });
    return globalThis.Response.json({
      data: [
        {
          id: ids[authorization === "Bearer KEY_A" ? 0 : 1],
          context_length: 4096,
          top_provider: { max_completion_tokens: 1024 },
          pricing: { prompt: "-1", completion: "0.000003" },
        },
      ],
    });
  });
  const refresh = async (value) => {
    const result = await value.refresh({ allowNetwork: true, force: true, providers: ["openrouter"] });
    assert.equal(result.errors.size, 0, [...result.errors.values()].join("\n"));
  };
  const names = (value) =>
    value
      .getModels()
      .filter((model) => model.provider === "openrouter")
      .map((model) => model.id);
  await refresh(first);
  assert.deepEqual(names(first), [ids[0]]);
  assert.equal(first.getModel("openrouter", ids[0]).contextWindow, 4096);
  assert.equal(first.getModel("openrouter", ids[0]).maxTokens, 1024);
  assert.equal(first.getModel("openrouter", ids[0]).cost.input, 0);
  assert.ok(first.getAllModels().some((model) => model.provider === "openrouter" && model.type === "image"));
  const second = await runtime("KEY_B");
  await refresh(second);
  assert.deepEqual(names(second), [ids[1]]);
  const offline = await runtime("KEY_A");
  await offline.refresh({ allowNetwork: false, providers: ["openrouter"] });
  assert.deepEqual(
    names(offline),
    [ids[1]],
    "documented limitation: persisted catalog is keyed by provider, not credential",
  );
  assert.deepEqual(requests, ["Bearer KEY_A", "Bearer KEY_B"]);
  const stored = readFileSync(cache, "utf8");
  assert.ok(!stored.includes("KEY_A") && !stored.includes("KEY_B"));
  for (const fallback of [401, 403, 404]) {
    status = fallback;
    await refresh(first);
    assert.ok(names(first).length > 2);
  }
  const beforeCancel = readFileSync(cache, "utf8");
  hold = true;
  status = 200;
  const controller = new globalThis.AbortController();
  const refreshing = first.refresh({
    allowNetwork: true,
    force: true,
    providers: ["openrouter"],
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  assert.equal((await refreshing).aborted, true);
  assert.equal(readFileSync(cache, "utf8"), beforeCancel);
});

test("saved OpenRouter credentials take precedence over an environment key", async () => {
  const auth = envApiKeyAuth("fixture", ["OPENROUTER_API_KEY"]);
  let envReads = 0;
  const result = await auth.resolve({
    credential: { type: "api_key", key: "STORED" },
    ctx: {
      env: async () => {
        envReads++;
        return "ENVIRONMENT";
      },
    },
    signal: new globalThis.AbortController().signal,
  });
  assert.equal(result.auth.apiKey, "STORED");
  assert.equal(envReads, 0);
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
  const { probePiRuntimeModules } = await importTestBundle("pi-120-runtime-probe", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/pi-runtime-probe.ts"],
  });
  const piVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies[
    "@earendil-works/pi-coding-agent"
  ];
  assert.deepEqual(await probePiRuntimeModules(), { piVersion, openaiOAuthLoaded: true, mcpLoaded: true });
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
