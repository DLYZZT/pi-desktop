import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { getModel, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as gemini } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as vertex } from "@earendil-works/pi-ai/api/google-vertex";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const { createAutoRoutingExtension, AgentSessionWrapper } = await importTestBundle("pi-161-auto-provider", {
  packages: "external",
  stdin: {
    loader: "ts",
    resolveDir: import.meta.dirname,
    contents:
      'export {createAutoRoutingExtension} from "./auto-routing";export {AgentSessionWrapper} from "./rpc-manager";',
  },
});
const sample = { role: "user", content: "fixture", timestamp: 1 };
test("OpenAI completions needs both a reasoning model and developer role support", async () => {
  for (const [provider, reasoning, support, expected] of [
    ["fixture", true, undefined, "system"],
    ["fixture", true, true, "developer"],
    ["fixture", false, true, "system"],
    ["openai", true, undefined, "developer"],
    ["openai", false, undefined, "system"],
    ["openai", true, false, "system"],
  ]) {
    const model = {
      ...getModel("openai", "gpt-6.2-sol"),
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      provider,
      reasoning,
      compat: support === undefined ? {} : { supportsDeveloperRole: support },
    };
    let actual;
    await completions(model, normalizeContext({ systemPrompt: "Fixture instruction", messages: [sample] }), {
      apiKey: "fixture",
      maxRetries: 0,
      onPayload(p) {
        actual = p.messages[0].role;
        throw Error("Local capture");
      },
      fetch: async () => assert.fail("No request should be sent"),
    }).result();
    assert.equal(actual, expected);
  }
});
test("Gemini and Vertex map XHIGH, strict tool mode and explicit prompt blocks through their real adapters", async () => {
  for (const [provider, adapter] of [
    ["google", gemini],
    ["google-vertex", vertex],
  ]) {
    const base = getModel(provider, "gemini-4-hydrogen");
    const context = normalizeContext({
      messages: [sample],
      tools: [
        {
          name: "lookup",
          description: "Fixture",
          parameters: { type: "object", properties: {} },
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        },
      ],
    });
    let payload,
      attempts = 0;
    const result = await adapter({ ...base, compat: { ...base.compat, supportsStrictMode: true } }, context, {
      apiKey: "offline-fixture",
      reasoning: "xhigh",
      maxRetries: 1,
      onPayload(p) {
        payload = p;
      },
      fetch: async () => {
        attempts++;
        return new globalThis.Response(
          "data: " +
            JSON.stringify({
              promptFeedback: {
                blockReason: "SAFETY",
                safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: "HIGH" }],
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    }).result();
    assert.equal(payload.config.thinkingConfig.thinkingLevel, "XHIGH");
    assert.equal(payload.config.toolConfig.functionCallingConfig.mode, "VALIDATED");
    assert.equal(attempts, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /SAFETY/);
    assert.match(result.errorMessage, /HARASSMENT/);
    assert.equal(isRetryableAssistantError(result), false);
  }
});
test("Auto uses the other configured model only after provider retries reach the session retry boundary", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-161-auto-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = "fixture-gateway",
    fast = { provider, modelId: "fast" },
    strong = { provider, modelId: "strong" };
  for (const [thinking, failures, providerRetries, enabled, retryFallback, expected] of [
    ["low", 1, 1, true, true, ["fast", "fast"]],
    ["low", 2, 1, true, true, ["fast", "fast", "strong"]],
    ["high", 1, 0, true, true, ["strong", "fast"]],
    ["high", 1, 0, true, false, ["strong", "strong"]],
    ["low", 1, 0, false, true, ["fast"]],
    ["high", 2, 0, true, true, ["strong", "fast"]],
  ]) {
    const dir = fs.mkdtempSync(path.join(root, "case-"));
    fs.writeFileSync(
      path.join(dir, "desktop-routing.json"),
      JSON.stringify({
        enabled: true,
        strategy: "thinking",
        fast,
        strong,
        fastThinking: "low",
        strongThinking: "high",
        retryFallback,
      }),
    );
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture",
      models: [fast, strong].map((ref) => ({
        id: ref.modelId,
        name: ref.modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 2048,
      })),
    });
    const settingsManager = SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: providerRetries } },
    });
    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [createAutoRoutingExtension(dir)],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(dir),
      model: runtime.getModel("pi-desktop-router", "auto"),
      thinkingLevel: thinking,
      tools: [],
    });
    const wrapper = new AgentSessionWrapper(session, [], () => {});
    wrapper.start();
    const switches = [],
      snapshots = [];
    wrapper.onEvent((event) => {
      if (event.retryInfo?.modelSwitch) {
        switches.push(event.retryInfo.modelSwitch);
        snapshots.push(wrapper.send({ type: "get_state" }));
      }
    });
    try {
      await session.bindExtensions({ mode: "rpc" });
      const sends = [];
      const fetch = async (req, init) => {
        const body = JSON.parse(init?.body ?? (await req.text()));
        sends.push(body.model);
        if (sends.length <= failures)
          return globalThis.Response.json(
            { error: { message: "The provider is temporarily unavailable. Retry shortly." } },
            { status: 503, headers: { "retry-after-ms": "1" } },
          );
        const chunk = {
          id: "fixture",
          model: body.model,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        };
        return new globalThis.Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      };
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (m, c, o) => stream.call(session.agent, m, c, { ...o, fetch });
      await session.prompt("Fixture");
      assert.deepEqual(sends, expected);
      const changes = expected.flatMap((id, i) =>
        i && id !== expected[i - 1] ? [{ from: provider + "/" + expected[i - 1], to: provider + "/" + id }] : [],
      );
      assert.deepEqual(switches, changes);
      assert.deepEqual(
        (await Promise.all(snapshots)).map((s) => s.retryInfo.modelSwitch),
        changes,
      );
      assert.equal((await wrapper.send({ type: "get_state" })).retryInfo, null);
      assert.equal(session.model.id, "auto");
    } finally {
      await wrapper.dispose();
    }
  }
});
