import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
const { SessionModelSelection, createDesktopAgentSessionServices, AgentSessionWrapper, readSessionSnapshot } =
  await importTestBundle("session-model-selection", {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: `
    export {SessionModelSelection} from './session-model-selection.ts';
    export {createDesktopAgentSessionServices} from './desktop-session-services.ts';
    export {AgentSessionWrapper} from './rpc-manager.ts';
    export {readSessionSnapshot} from './session-readonly.ts';`,
    },
  });
const old = "azure-openai-responses",
  modelId = "gpt-6.1-sol";

test("invalid models.json blocks fallback requests until repaired but catalog refresh errors do not", () => {
  const selection = new SessionModelSelection();
  let error = "Invalid models.json schema:\n contextWindow must be > 0";
  const inner = { model: { provider: "anthropic", id: "fixture" }, modelRuntime: { getError: () => error } };
  assert.equal(selection.snapshot(inner).reason, "config-invalid");
  assert.throws(() => selection.assertReady(inner), /MODEL_CONFIG_INVALID/);
  selection.selected(inner.model);
  assert.throws(() => selection.assertReady(inner), /MODEL_CONFIG_INVALID/);
  let warming;
  selection.extension().factory({
    on(name, handler) {
      if (name === "cache_warming_decision") warming = handler;
    },
  });
  assert.deepEqual(warming({}, { modelRegistry: { getError: () => error } }), { action: "stop" });
  error = "Availability refresh: temporary offline failure";
  assert.throws(() => selection.assertReady(inner), /MODEL_SELECTION_REQUIRED/);
  assert.deepEqual(warming({}, { modelRegistry: { getError: () => error } }), { action: "stop" });
  assert.doesNotThrow(() => new SessionModelSelection().assertReady(inner), "catalog errors alone do not block");
  selection.selected(inner.model);
  assert.doesNotThrow(() => selection.assertReady(inner));
  assert.equal(warming({}, { modelRegistry: { getError: () => error } }), undefined);
  error = undefined;
  assert.equal(selection.snapshot(inner), undefined);
});
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
for (const custom of [false, true])
  test(`repair and reload restore the configured endpoint for ${custom ? "a saved custom model" : "a builtin model override"}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-model-config-recovery-"));
    const provider = custom ? "fixture" : "anthropic",
      id = custom ? "saved-model" : "claude-sonnet-4-5";
    const config = {
      providers: {
        broken: {
          api: "openai-completions",
          baseUrl: "https://broken.invalid/v1",
          models: [{ id: "invalid", contextWindow: 0 }],
        },
        [provider]: {
          baseUrl: "https://configured-endpoint.invalid/v1",
          ...(custom
            ? {
                api: "openai-completions",
                models: [{ id, contextWindow: 8192, maxTokens: 1024 }],
              }
            : { modelOverrides: { [id]: { maxTokens: 1024 } } }),
        },
      },
    };
    const filename = path.join(root, "models.json");
    writeFileSync(filename, JSON.stringify(config));
    writeFileSync(
      path.join(root, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "OFFLINE_FIXTURE" },
        fixture: { type: "api_key", key: "OFFLINE_FIXTURE" },
      }),
    );
    writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ defaultProvider: provider, defaultModel: id, defaultTools: [], cacheWarming: "off" }),
    );
    const manager = SessionManager.inMemory(root);
    manager.appendModelChange(provider, id);
    manager.appendMessage({ role: "user", content: "saved conversation", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      provider,
      model: id,
      api: custom ? "openai-completions" : "anthropic-messages",
      content: [{ type: "text", text: "saved reply" }],
      timestamp: 2,
      stopReason: "stop",
      usage,
    });
    const guard = new SessionModelSelection();
    const services = await createDesktopAgentSessionServices({
      cwd: root,
      agentDir: root,
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [guard.extension()],
      },
    });
    guard.prepare(services, manager);
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      tools: [],
    });
    guard.finish(session, modelFallbackMessage);
    const wrapper = new AgentSessionWrapper(session, [], () => {}, undefined, undefined, undefined, undefined, guard);
    wrapper.start();
    const requests = [];
    session.agent.streamFunction = (model) => {
      requests.push(model);
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "recovered" }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage,
      };
      globalThis.queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    };
    t.after(async () => {
      await wrapper.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    assert.equal(guard.snapshot(session).reason, "config-invalid");
    assert.throws(
      () => guard.assertReady(session),
      (error) => error.code === "MODEL_CONFIG_INVALID",
    );
    await assert.rejects(
      wrapper.runExternalTurn({ runId: "invalid", channel: "telegram", message: "blocked" }),
      (error) => error.code === "MODEL_CONFIG_INVALID",
    );
    assert.equal(requests.length, 0);
    config.providers.broken.models[0].contextWindow = 4096;
    writeFileSync(filename, JSON.stringify(config));
    if (!custom) {
      await services.modelRuntime.refresh({ allowNetwork: false });
      assert.equal(services.modelRuntime.getError(), undefined);
      assert.throws(
        () => guard.assertReady(session),
        /MODEL_SELECTION_REQUIRED/,
        "catalog recovery cannot unlock stale endpoint objects",
      );
    }
    await wrapper.send({ type: "reload" });
    assert.equal(session.modelRuntime.getError(), undefined);
    assert.deepEqual({ provider: session.model.provider, id: session.model.id }, { provider, id });
    assert.equal(session.model.baseUrl, "https://configured-endpoint.invalid/v1");
    assert.equal(session.model.maxTokens, 1024);
    assert.doesNotThrow(() => guard.assertReady(session));
    assert.equal(
      (await wrapper.runExternalTurn({ runId: "repaired", channel: "telegram", message: "continue" })).finalText,
      "recovered",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].baseUrl, "https://configured-endpoint.invalid/v1");
  });

test("config recovery keeps sends and warming blocked when the original model is missing or cannot authenticate", async () => {
  for (const failure of ["missing", "authentication"]) {
    const guard = new SessionModelSelection();
    let error = "Invalid models.json schema: contextWindow";
    const model = { provider: "fixture", id: "original" };
    const inner = {
      model,
      modelRuntime: {
        getError: () => error,
        getModel: () => (failure === "missing" ? undefined : model),
        refresh: async () => {
          error = undefined;
        },
      },
      setModel: async () => {
        throw new Error("authentication unavailable");
      },
    };
    assert.equal(guard.prepareConfigRecovery(inner), true);
    if (failure === "authentication") await assert.rejects(guard.restoreAfterConfigRepair(inner), /authentication/);
    else await guard.restoreAfterConfigRepair(inner);
    assert.throws(() => guard.assertReady(inner), /MODEL_SELECTION_REQUIRED/);
    let warming;
    guard.extension().factory({
      on: (name, handler) => {
        if (name === "cache_warming_decision") warming = handler;
      },
    });
    assert.deepEqual(warming({}, { modelRegistry: inner.modelRuntime }), { action: "stop" });
  }
});

async function fixture(t, { conflict = false, missing = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-azure-restore-"));
  let wrapper;
  t.after(async () => {
    await wrapper?.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(root, "auth.json"),
    JSON.stringify({
      [old]: { type: "api_key", key: "LEGACY_FIXTURE" },
      anthropic: { type: "api_key", key: "OTHER_FIXTURE" },
      ...(conflict ? { azure: { type: "api_key", key: "CURRENT_FIXTURE" } } : {}),
    }),
  );
  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      defaultProvider: old,
      defaultModel: missing ? "missing-model" : modelId,
      cacheWarming: "off",
      modelThinkingLevels: { [old + "/" + modelId]: "high" },
    }),
  );
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendModelChange(old, missing ? "missing-model" : modelId);
  manager.appendThinkingLevelChange("high");
  manager.appendMessage({ role: "user", content: "Original Azure conversation", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    api: old,
    provider: old,
    model: missing ? "missing-model" : modelId,
    content: [{ type: "text", text: "ORIGINAL_AZURE_MESSAGE" }],
    stopReason: "stop",
    timestamp: 2,
    usage,
  });
  const file = manager.getSessionFile(),
    original = readFileSync(file, "utf8");
  readSessionSnapshot(file);
  assert.equal(readFileSync(file, "utf8"), original, "read-only sidebar access never migrates native history");
  const guard = new SessionModelSelection();
  const services = await createDesktopAgentSessionServices({
    cwd: root,
    agentDir: root,
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [guard.extension()],
    },
  });
  const model = guard.prepare(services, manager);
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    ...(model ? { model } : {}),
  });
  guard.finish(result.session, result.modelFallbackMessage);
  wrapper = new AgentSessionWrapper(result.session, [], () => {}, undefined, undefined, undefined, undefined, guard);
  const requests = [],
    events = [];
  result.session.agent.streamFunction = (model) => {
    requests.push(model);
    const stream = createAssistantMessageEventStream(),
      message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "OFFLINE_RESPONSE" }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage,
      };
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  return { root, manager, file, original, services, guard, session: result.session, wrapper, requests, events };
}
async function send(f, id = 1) {
  await f.wrapper.send({ type: "prompt", message: "Offline verification", clientRunId: id });
  const deadline = Date.now() + 3000;
  while (!f.events.some((event) => event.type === "prompt_done" && event.clientRunId === id)) {
    if (Date.now() > deadline) throw new Error("prompt did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    f.events.some((event) => event.type === "prompt_error"),
    false,
    JSON.stringify(f.events),
  );
}
test("old Azure sessions restore the same model under azure and append selection without rewriting old provider/API fields", async (t) => {
  const f = await fixture(t);
  assert.equal(f.services.azureUpgrade.status, "migrated");
  assert.equal(f.session.model.provider, "azure");
  assert.equal(f.session.model.id, modelId);
  assert.equal(f.session.model.api, old);
  const notice = (await f.wrapper.send({ type: "get_state" })).modelSelectionNotice;
  assert.equal(notice.requiresChoice, false);
  assert.deepEqual(notice.requested, { provider: old, modelId });
  assert.deepEqual(notice.actual, { provider: "azure", modelId });
  assert.ok(readFileSync(f.file, "utf8").startsWith(f.original));
  assert.equal(
    f.manager
      .getEntries()
      .filter((entry) => entry.type === "model_change")
      .at(-1).provider,
    "azure",
  );
  await send(f);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].provider, "azure");
  assert.equal(
    f.manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.content?.[0]?.text === "ORIGINAL_AZURE_MESSAGE")
      .message.provider,
    old,
  );
});

test("a queued prompt rechecks branch model intent at execution, even after an earlier successful Azure migration", async (t) => {
  const f = await fixture(t),
    gate = createDeferred();
  const prior = f.wrapper.enqueueTurn(() => gate.promise);
  await f.wrapper.send({ type: "prompt", message: "Queued request", clientRunId: 77 });
  f.manager.appendModelChange(old, "missing-after-branch-change");
  gate.resolve();
  await prior;
  const deadline = Date.now() + 3000;
  while (!f.events.some((event) => event.type === "prompt_done" && event.clientRunId === 77)) {
    if (Date.now() > deadline) throw new Error("queued prompt did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(f.requests.length, 0);
  assert.match(f.events.find((event) => event.type === "prompt_error").errorMessage, /MODEL_SELECTION_REQUIRED/);
});
for (const options of [{ conflict: true }, { missing: true }])
  test(`unsafe Azure restore requires explicit selection before local or channel requests: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options),
      state = await f.wrapper.send({ type: "get_state" });
    assert.equal(state.modelSelectionNotice.requiresChoice, true);
    assert.equal(state.modelSelectionNotice.actual?.provider, f.session.model?.provider);
    await assert.rejects(f.wrapper.send({ type: "prompt", message: "Do not send" }), /MODEL_SELECTION_REQUIRED/);
    await assert.rejects(f.wrapper.send({ type: "compact" }), /MODEL_SELECTION_REQUIRED/);
    await assert.rejects(
      f.wrapper.runExternalTurn({ runId: "blocked", message: "Do not send", channel: "telegram" }),
      /MODEL_SELECTION_REQUIRED/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(readFileSync(f.file, "utf8"), f.original);
    await f.wrapper.send({ type: "set_model", provider: "azure", modelId });
    assert.equal((await f.wrapper.send({ type: "get_state" })).modelSelectionNotice, undefined);
    await send(f);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].provider, "azure");
    if (options.conflict) {
      const auth = JSON.parse(readFileSync(path.join(f.root, "auth.json")));
      assert.equal(auth[old].key, "LEGACY_FIXTURE");
      assert.equal(auth.azure.key, "CURRENT_FIXTURE");
    }
  });
