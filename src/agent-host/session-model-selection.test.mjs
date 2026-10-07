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
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
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
