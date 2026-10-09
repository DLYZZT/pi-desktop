import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";

const directory = mkdtempSync(path.join(tmpdir(), "pi-model-settings-handlers-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_OFFLINE = "1";
test.after(() => rmSync(directory, { recursive: true, force: true }));
const { createModelSettingsHandlers, modelConfigHandlers } = await importTestBundle("model-settings-handlers", {
  packages: "external",
  stdin: {
    loader: "ts",
    resolveDir: import.meta.dirname,
    contents: `export {createModelSettingsHandlers} from './handlers/model-settings.ts'; export {modelConfigHandlers} from './handlers/models-config.ts';`,
  },
});
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("model tests dispatch by type, including models with the same provider/id, and report failed results", async () => {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw Error("read only");
      },
      delete: async () => {},
    },
  });
  const chat = {
    ...runtime.getModel("anthropic", "claude-sonnet-4-5"),
    provider: "test-provider",
    id: "shared",
    name: "Shared chat",
  };
  const classifier = {
    ...runtime.getModelOfType("classifier", "typesafe", "jev-latest"),
    provider: "test-provider",
    id: "shared",
    name: "Shared decision",
  };
  const image = {
    type: "image",
    provider: "test-provider",
    id: "shared",
    name: "Shared image",
    api: "openrouter-images",
    baseUrl: "http://fixture.invalid",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0 },
  };
  const calls = [];
  const stream = (actual) => {
    calls.push("chat");
    const output = createAssistantMessageEventStream();
    globalThis.queueMicrotask(() => {
      output.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: actual.api,
          provider: actual.provider,
          model: actual.id,
          content: [{ type: "text", text: "OK" }],
          usage,
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      output.end();
    });
    return output;
  };
  let fail = false;
  runtime.registerNativeProvider({
    id: "test-provider",
    name: "Test provider",
    auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "synthetic" }, source: "fixture" }) } },
    getModels: () => [chat],
    getAllModels: () => [chat, classifier, image],
    stream,
    streamSimple: stream,
    async classify(actual, context, options) {
      calls.push("classifier");
      assert.equal(actual.type, "classifier");
      assert.equal(context.questions.check.type, "bool");
      assert.equal(options.maxRetries, 0);
      return {
        provider: actual.provider,
        model: actual.id,
        api: actual.api,
        answers: { check: { type: "bool", probability: 1 } },
        usage,
        stopReason: fail ? "error" : "stop",
        ...(fail ? { errorMessage: "Fixture rejected" } : {}),
      };
    },
    async generateImages(actual, context) {
      calls.push("image");
      assert.equal(actual.type, "image");
      assert.equal(context.input[0].type, "text");
      return { output: [{ type: "image", data: "fixture", mimeType: "image/png" }], stopReason: "stop", usage };
    },
  });
  const handlers = createModelSettingsHandlers(async () => runtime);
  for (const type of ["chat", "classifier", "image"])
    assert.equal((await handlers.test({ provider: "test-provider", modelId: "shared", type })).ok, true);
  assert.deepEqual(calls, ["chat", "classifier", "image"]);
  fail = true;
  assert.equal(
    (await handlers.test({ provider: "test-provider", modelId: "shared", type: "classifier" })).error,
    "Fixture rejected",
  );
  const catalog = (await handlers.catalog()).models.filter((model) => model.provider === "test-provider");
  assert.equal(catalog.length, 3);
  assert.ok(catalog.every((model) => model.available));
});

test("models.json save validates advanced model fields before replacing the file and preserves valid overrides", async () => {
  const first = await modelConfigHandlers.get();
  const config = {
    providers: {
      fixture: {
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        apiKey: "synthetic",
        models: [
          {
            id: "fixture",
            samplingParams: { temperature: 0.2 },
            samplingParamsByThinkingLevel: { high: { temperature: 0.4 } },
          },
        ],
      },
    },
  };
  await modelConfigHandlers.set({ config, expectedVersion: first.version });
  const file = path.join(directory, "models.json"),
    original = readFileSync(file, "utf8");
  assert.equal(JSON.parse(original).providers.fixture.models[0].samplingParamsByThinkingLevel.high.temperature, 0.4);
  const current = await modelConfigHandlers.get();
  const invalid = globalThis.structuredClone(config);
  invalid.providers.fixture.models[0].contextWindow = "invalid";
  await assert.rejects(
    modelConfigHandlers.set({ config: invalid, expectedVersion: current.version }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.equal(readFileSync(file, "utf8"), original);
});
