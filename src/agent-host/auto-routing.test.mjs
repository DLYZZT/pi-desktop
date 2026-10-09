import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";

const {
  routeDesktopModel,
  createDesktopAgentSessionServices,
  SessionModelSelection,
  buildSessionHistoryPage,
  buildSessionStats,
  readRoutingSettings,
  saveRoutingSettings,
  readAdvancedSettings,
  saveAdvancedSettings,
} = await importTestBundle("desktop-auto-routing", {
  packages: "external",
  stdin: {
    loader: "ts",
    resolveDir: import.meta.dirname,
    contents: `
    export {routeDesktopModel} from './auto-routing.ts';
    export {createDesktopAgentSessionServices} from './desktop-session-services.ts';
    export {SessionModelSelection} from './session-model-selection.ts';
    export {buildSessionHistoryPage} from './session-history.ts';
    export {buildSessionStats} from './session-stats.ts';
    export * from './model-settings-store.ts';`,
  },
});
const usage = {
  input: 2,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};
const reference = (id) => ({ provider: "fixture", modelId: id });
const config = {
  enabled: true,
  strategy: "thinking",
  fast: reference("fast"),
  strong: reference("strong"),
  classifier: reference("judge"),
  fastThinking: "low",
  strongThinking: "high",
  retryFallback: true,
};
const model = (id) => ({ provider: "fixture", id, api: "openai-responses" });
const request = () => ({
  model: { api: "pi-virtual" },
  thinkingLevel: "high",
  reason: "user",
  messages: [{ role: "user", content: "Fix this", timestamp: 1 }],
  signal: new globalThis.AbortController().signal,
});

test("routing selects capable/fast models and keeps tool continuations sticky while supporting retry fallback", async () => {
  const ctx = { modelRegistry: { find: (_provider, id) => model(id) } };
  const record = () => assert.fail("thinking routing must not call a classifier");
  assert.equal((await routeDesktopModel(config, request(), ctx, record)).model.id, "strong");
  assert.equal((await routeDesktopModel(config, { ...request(), thinkingLevel: "low" }, ctx, record)).model.id, "fast");
  const previous = { model: model("fast"), thinkingLevel: "low" };
  assert.equal(
    (await routeDesktopModel(config, { ...request(), reason: "continuation", previous }, ctx, record)).model.id,
    "fast",
  );
  assert.equal(
    (await routeDesktopModel(config, { ...request(), reason: "retry", failed: previous }, ctx, record)).model.id,
    "strong",
  );
});

test("classifier routing records usage once, preserves cancellation, and fails if accounting cannot persist", async () => {
  const controller = new globalThis.AbortController(),
    records = [];
  let calls = 0;
  const ctx = {
    modelRegistry: {
      find: (_provider, id) => model(id),
      findOfType: () => model("judge"),
      classify: async () => {
        calls++;
        return {
          stopReason: "stop",
          answers: { complexity: { type: "choice", probabilities: { simple: 0.9, complex: 0.1 } } },
          usage,
        };
      },
    },
  };
  const classifierConfig = { ...config, strategy: "classifier" };
  const route = await routeDesktopModel(classifierConfig, request(), ctx, (...record) => records.push(record));
  assert.equal(route.model.id, "fast");
  assert.equal(calls, 1);
  assert.deepEqual(records, [["fixture", "judge", usage]]);
  await assert.rejects(
    routeDesktopModel(classifierConfig, request(), ctx, () => {
      throw Error("disk full");
    }),
    /disk full/,
  );
  ctx.modelRegistry.classify = async () => {
    throw Error("provider unavailable");
  };
  assert.equal((await routeDesktopModel(classifierConfig, request(), ctx, () => {})).model.id, "strong");
  ctx.modelRegistry.classify = async () => {
    controller.abort();
    throw controller.signal.reason;
  };
  await assert.rejects(
    routeDesktopModel(classifierConfig, { ...request(), signal: controller.signal }, ctx, () => {}),
    { name: "AbortError" },
  );
  ctx.modelRegistry.find = () => ({ ...model("nested"), api: "pi-virtual" });
  await assert.rejects(
    routeDesktopModel(config, request(), ctx, () => {}),
    /physical model/,
  );
});

test("settings persist Pi advanced options, preserve unrelated settings, and reject stale or invalid writes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-routing-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "keep", skills: ["keep"] }));
  const first = readRoutingSettings(root);
  const saved = await saveRoutingSettings(config, first.version, root);
  assert.deepEqual(saved.config, config);
  await assert.rejects(saveRoutingSettings(config, first.version, root), (error) => error.code === "CONFLICT");
  const advanced = readAdvancedSettings(root);
  const next = {
    compaction: {
      reserveTokens: 1024,
      keepRecentTokens: 2048,
      modelOverrides: { "fixture/fast": { reserveTokens: 512 } },
    },
    retry: { maxRetries: 2, provider: { timeoutMs: 8000, maxRetries: 0 } },
    transport: "sse",
  };
  await saveAdvancedSettings(next, advanced.version, root);
  const raw = JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8"));
  assert.equal(raw.defaultProvider, "keep");
  assert.deepEqual(raw.skills, ["keep"]);
  const settings = SettingsManager.create(root, root);
  assert.equal(settings.getCompactionSettings().reserveTokens, 1024);
  await assert.rejects(
    saveAdvancedSettings({ retry: { maxRetries: -1 } }, readAdvancedSettings(root).version, root),
    /non-negative/,
  );
  writeFileSync(path.join(root, "settings.json"), "broken");
  assert.throws(() => readAdvancedSettings(root), /parse/);
});

test("a real SDK session restores Auto after physical replies, retains branch selection, and can route the next turn", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-routing-restore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw Error("Read-only test credentials");
      },
    },
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("anthropic", "offline-fixture");
  const fast = { provider: "anthropic", modelId: "claude-haiku-4-5" },
    strong = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
  await saveRoutingSettings({ ...config, fast, strong }, "missing", root);
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendModelChange("pi-desktop-router", "auto");
  manager.appendThinkingLevelChange("high");
  manager.appendMessage({ role: "user", content: "First turn", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    provider: fast.provider,
    model: fast.modelId,
    api: "anthropic-messages",
    content: [{ type: "text", text: "First reply" }],
    usage,
    stopReason: "stop",
    timestamp: 2,
  });
  const reopened = SessionManager.open(manager.getSessionFile());
  const services = await createDesktopAgentSessionServices(
    {
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
      resourceLoaderOptions: { noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
    },
    { sessionManager: reopened },
  );
  const guard = new SessionModelSelection();
  guard.prepare(services, reopened);
  const { session, modelFallbackMessage } = await createAgentSessionFromServices({
    services,
    sessionManager: reopened,
    tools: [],
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  guard.finish(session, modelFallbackMessage);
  assert.equal(session.model.provider, "pi-desktop-router");
  assert.equal(guard.snapshot(session), undefined);
  assert.doesNotThrow(() => guard.assertReady(session));
  const page = buildSessionHistoryPage({
    entries: reopened.getEntries(),
    historyRevision: "fixture",
    historyWindow: { maxTurns: 2 },
  });
  assert.deepEqual(page.selectedModel, { provider: "pi-desktop-router", modelId: "auto" });
  const requests = [];
  session.agent.streamFunction = (actual) => {
    requests.push(actual);
    const stream = createAssistantMessageEventStream();
    globalThis.queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: actual.api,
          provider: actual.provider,
          model: actual.id,
          content: [{ type: "text", text: "Routed reply" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage,
        },
      });
      stream.end();
    });
    return stream;
  };
  await session.prompt("Second turn");
  assert.equal(requests[0].id, strong.modelId);
  assert.equal(session.model.id, "auto");
  const stats = buildSessionStats(reopened.getEntries(), { sessionId: reopened.getSessionId() });
  assert.equal(stats.modelUsage.length, 2);
  assert.equal(
    stats.modelUsage.reduce((sum, row) => sum + row.cost, 0),
    stats.cost,
  );
});
