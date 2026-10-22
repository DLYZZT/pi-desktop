import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createAssistantMessageEventStream, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

const { AgentSessionWrapper, markModelConfigChanged } = await importTestBundle("thinking-session-wrapper", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export { AgentSessionWrapper } from "./rpc-manager.ts"; export { markModelConfigChanged } from "./model-config-revision.ts";',
  },
});

test(
  "saved mappings refresh the live session before reasoning changes and the next prompt",
  { timeout: 10000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-live-thinking-config-"));
    const modelsPath = path.join(root, "models.json");
    const definition = {
      id: "reasoner",
      reasoning: true,
      thinkingLevelMap: { minimal: "max" },
      compat: { thinkingFormat: "deepseek" },
    };
    const provider = {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "fixture",
      models: [definition],
    };
    const save = () => writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: provider } }));
    save();
    const runtime = await ModelRuntime.create({
      modelsPath,
      refreshOnCreate: false,
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => {
          throw Error("read-only");
        },
        delete: async () => {},
      },
    });
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
    });
    const manager = SessionManager.create(root, root);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: runtime.getModel("fixture", "reasoner"),
      tools: [],
    });
    const wrapper = new AgentSessionWrapper(session, [], () => {});
    wrapper.start();
    t.after(async () => {
      await wrapper.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    await wrapper.send({ type: "set_thinking_level", level: "minimal" });
    const before = session.model;
    definition.thinkingLevelMap = { minimal: "max", xhigh: "xhigh", max: "max" };
    save();
    markModelConfigChanged();
    for (const level of ["xhigh", "max"]) {
      await wrapper.send({ type: "set_thinking_level", level });
      assert.equal(session.thinkingLevel, level);
      assert.notEqual(session.model, before);
      let payload;
      await streamSimple(
        session.model,
        { messages: [] },
        {
          apiKey: "fixture",
          reasoning: session.thinkingLevel,
          onPayload(value) {
            payload = value;
            throw Error("captured before network");
          },
        },
      ).result();
      assert.equal(payload.reasoning_effort, level);
    }
    const modelChanges = () => manager.getBranch().filter((entry) => entry.type === "model_change").length;
    const count = modelChanges();
    await wrapper.send({ type: "set_thinking_level", level: "minimal" });
    assert.equal(modelChanges(), count, "unchanged config must not append redundant model changes");
    definition.thinkingLevelMap = { minimal: "low", xhigh: null, max: "max" };
    save();
    markModelConfigChanged();
    const observed = new Promise((resolve) => {
      session.agent.streamFunction = (model, _context, options) => {
        resolve({ level: options.reasoning, mapping: model.thinkingLevelMap });
        const output = createAssistantMessageEventStream();
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: "OK" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        globalThis.queueMicrotask(() => {
          output.push({ type: "done", reason: "stop", message });
          output.end();
        });
        return output;
      };
    });
    await wrapper.send({ type: "prompt", message: "Verify the saved mapping without reselecting a level" });
    assert.deepEqual(await observed, { level: "minimal", mapping: definition.thinkingLevelMap });
    await session.waitForIdle();
    await wrapper.send({ type: "set_thinking_level", level: "xhigh" });
    assert.equal(session.thinkingLevel, "max", "disabled levels use the updated SDK capabilities");
    provider.models = [];
    save();
    markModelConfigChanged();
    await assert.rejects(wrapper.send({ type: "set_thinking_level", level: "high" }), /no longer configured/);
  },
);

test("real SDK sends max, restores it from history and clamps it when switching to an unsupported model", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-max-"));
  const sessions = [];
  t.after(() => {
    for (const session of sessions) session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {},
      async list() {
        return [];
      },
      async modify() {
        throw Error("read-only");
      },
      async delete() {
        throw Error("read-only");
      },
    },
  });
  const model = runtime.getModels("openai").find((model) => getSupportedThinkingLevels(model).includes("max"));
  assert.ok(model);
  await runtime.setRuntimeApiKey("openai", "synthetic-max-test");
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
  });
  const manager = SessionManager.create(root, root);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [] });
  sessions.push(session);
  session.setThinkingLevel("max");
  let reasoning;
  session.agent.streamFunction = (selected, _context, options) => {
    reasoning = options.reasoning;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "max fixture" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await session.prompt("Verify max", { source: "rpc" });
  assert.equal(reasoning, "max");
  const restored = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.open(manager.getSessionFile()),
    tools: [],
  });
  sessions.push(restored.session);
  assert.equal(restored.session.thinkingLevel, "max");
  await restored.session.setModel(runtime.getModel("openai", "gpt-4o"));
  assert.equal(restored.session.thinkingLevel, "off");
});

test("DeepSeek custom mappings keep desktop state, transcript and outgoing reasoning consistent", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-thinking-map-"));
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw Error("read-only");
      },
      delete: async () => {},
    },
  });
  runtime.registerProvider("thinking-fixture", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture",
    models: [
      {
        id: "reasoner",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap: { minimal: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 2048,
        compat: { thinkingFormat: "deepseek" },
      },
    ],
  });
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
  });
  const manager = SessionManager.create(root, root);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel("thinking-fixture", "reasoner"),
    tools: [],
  });
  const wrapper = new AgentSessionWrapper(session, [], () => {});
  t.after(async () => {
    await wrapper.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  for (const [level, effective, wire] of [
    ["minimal", "minimal", "max"],
    ["xhigh", "high", "high"],
    ["max", "high", "high"],
  ]) {
    await wrapper.send({ type: "set_thinking_level", level });
    assert.equal(session.thinkingLevel, effective);
    assert.equal(
      manager
        .getBranch()
        .filter((entry) => entry.type === "thinking_level_change")
        .at(-1).thinkingLevel,
      effective,
    );
    let payload;
    await streamSimple(
      session.model,
      { messages: [] },
      {
        apiKey: "fixture",
        reasoning: session.thinkingLevel,
        onPayload(value) {
          payload = value;
          throw new Error("captured before network");
        },
      },
    ).result();
    assert.equal(payload.reasoning_effort, wire);
  }
  await session.setModel({ ...session.model, thinkingLevelMap: { xhigh: "max", max: "max" } });
  for (const level of ["xhigh", "max"]) {
    await wrapper.send({ type: "set_thinking_level", level });
    assert.equal(session.thinkingLevel, level);
  }
});
