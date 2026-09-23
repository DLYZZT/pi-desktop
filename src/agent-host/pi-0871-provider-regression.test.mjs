import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

test("0.87.1 model IDs and context windows remain provider-specific", () => {
  assert.equal(getModel("anthropic", "claude-opus-5-5")?.contextWindow, 1_000_000);
  assert.equal(getModel("github-copilot", "claude-opus-5.5")?.contextWindow, 1_000_000);
  for (const provider of ["openai", "openai-codex"]) {
    for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
      assert.equal(getModel(provider, id)?.contextWindow, 272_000);
    }
  }
  assert.equal(getModel("github-copilot", "gpt-6-sol")?.contextWindow, 1_000_000);
  assert.equal(getModel("xai", "grok-4.7")?.contextWindow, 500_000);
});

test("OpenAI-compatible image requests omit empty text but preserve words and spaces", async () => {
  const builtIn = getModel("openai", "gpt-4o-mini");
  assert.ok(builtIn);
  const model = { ...builtIn, api: "openai-completions", input: ["text", "image"] };
  const payloads = [];
  for (const text of ["", "Describe the image", " "]) {
    await completions(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: "offline-fixture-key",
        onPayload(payload) {
          payloads.push(payload);
          throw new Error("captured before network");
        },
      },
    ).result();
  }
  const content = payloads.map((payload) => payload.messages.find((message) => message.role === "user").content);
  assert.deepEqual(
    content[0].map((block) => block.type),
    ["image_url"],
  );
  assert.deepEqual(
    content[1].map((block) => block.type),
    ["text", "image_url"],
  );
  assert.equal(content[1][0].text, "Describe the image");
  assert.deepEqual(
    content[2].map((block) => block.type),
    ["text", "image_url"],
  );
  assert.equal(content[2][0].text, " ");
});

test("a root pi-ai Faux provider reaches its SDK session without leaking registration to another runtime", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-provider-compat-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = "pi-desktop-faux";
  const modelId = "fixture-model";
  const faux = createFauxCore({
    provider,
    api: "openai-completions",
    models: [{ id: modelId, name: "Fixture", reasoning: true, input: ["text"] }],
  });
  faux.setResponses([fauxAssistantMessage("ROOT_PROVIDER_REACHED_SDK")]);
  let request;
  let captureAdapterPayload = false;
  let serializedPayload;
  const resourceLoaderOptions = {
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "provider-fixture",
        factory(pi) {
          pi.registerProvider(provider, {
            name: "Fixture",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:0",
            apiKey: "offline-fixture-key",
            models: [
              {
                id: modelId,
                name: "Fixture",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 2048,
                compat: { supportsStrictMode: false, supportsReasoningEffort: true },
              },
            ],
            streamSimple(model, context, options) {
              request = {
                roles: context.messages.map((message) => message.role),
                tools: getCurrentTools(context.messages).map((tool) => tool.name),
                prompt: getCurrentSystemPrompt(context.messages),
                compat: model.compat,
              };
              if (captureAdapterPayload) {
                return completions(model, context, {
                  ...options,
                  apiKey: "offline-fixture-key",
                  onPayload(payload) {
                    serializedPayload = structuredClone(payload);
                    throw new Error("adapter payload captured before network");
                  },
                });
              }
              return faux.streamSimple(model, context, options);
            },
          });
        },
      },
    ],
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions,
  });
  const separate = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: { ...resourceLoaderOptions, extensionFactories: [] },
  });
  assert.equal(separate.modelRuntime.getModel(provider, modelId), undefined);
  const model = services.modelRuntime.getModel(provider, modelId);
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    model,
    tools: ["read"],
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("Use the configured provider", { source: "rpc" });
  assert.equal(session.getLastAssistantText(), "ROOT_PROVIDER_REACHED_SDK");
  assert.ok(request.roles.includes("system"));
  assert.ok(request.roles.includes("user"));
  assert.deepEqual(request.tools, ["read"]);
  assert.match(request.prompt, /<tools>[\s\S]*- read:/);
  assert.equal(request.compat.supportsStrictMode, false);

  captureAdapterPayload = true;
  session.setThinkingLevel("high");
  await session.prompt("Capture the real adapter payload", { source: "rpc" });
  assert.ok(serializedPayload);
  assert.equal(serializedPayload.messages[0].role, "developer");
  assert.match(serializedPayload.messages[0].content, /<tools>[\s\S]*- read:/);
  assert.equal(serializedPayload.tools[0].function.name, "read");
  assert.equal(serializedPayload.tools[0].function.strict, undefined);
  assert.equal(serializedPayload.reasoning_effort, "high");
});
