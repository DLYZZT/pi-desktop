import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";

const root = mkdtempSync(path.join(tmpdir(), "pi-provider-renames-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
test.after(() => rmSync(root, { recursive: true, force: true }));
const {
  withProviderRenames,
  migrateProviderSettings,
  migrateRoutingSettings,
  renamedSessionProvider,
  ensureProviderRenameSettings,
  modelConfigHandlers,
  createDesktopAgentSessionServices,
  SessionModelSelection,
  AgentSessionWrapper,
} = await importTestBundle("provider-renames", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export * from './provider-renames.ts';
    export {modelConfigHandlers} from './handlers/models-config.ts';
    export {createDesktopAgentSessionServices} from './desktop-session-services.ts';
    export {SessionModelSelection} from './session-model-selection.ts';
    export {AgentSessionWrapper} from './rpc-manager.ts';
  `,
  },
});

test("rename settings preserve enabled/disabled choices, defaults and mappings across swaps and reversals", () => {
  const original = {
    enabledModels: ["A/enabled:max", "bare-id", "other/keep"],
    defaultProvider: "A",
    defaultModel: "enabled",
    modelThinkingLevels: { "A/enabled": "minimal", "B/disabled": "high" },
    compaction: { modelOverrides: { "A/enabled": { reserveTokens: 512 } } },
    unrelated: true,
  };
  const history = [{ at: 100, names: { A: "B", B: "A" } }];
  const moved = migrateProviderSettings(original, history);
  assert.deepEqual(moved.enabledModels, ["B/enabled:max", "bare-id", "other/keep"]);
  assert.equal(moved.defaultProvider, "B");
  assert.equal(moved.modelThinkingLevels["B/enabled"], "minimal");
  assert.equal(moved.modelThinkingLevels["A/disabled"], "high");
  assert.deepEqual(moved.compaction.modelOverrides["B/enabled"], { reserveTokens: 512 });
  assert.equal(migrateProviderSettings(moved, []), moved, "no pending events leaves settings untouched");
  assert.equal(original.defaultProvider, "A");
  history.push({ at: 200, names: { B: "A", A: "B" } });
  const restored = migrateProviderSettings(moved, history.slice(1));
  for (const key of Object.keys(original)) assert.deepEqual(restored[key], original[key]);
  assert.equal(migrateProviderSettings({ enabledModels: null }, history).enabledModels, null);
  assert.deepEqual(migrateProviderSettings({ enabledModels: [] }, history).enabledModels, []);
});

test("session rename history follows the selection time, including names reused later and in-flight replies", () => {
  const entry = (provider, time) => ({
    type: "model_change",
    provider,
    modelId: "same",
    timestamp: new Date(time).toISOString(),
  });
  const history = [
    { at: 200, names: { A: "B", B: "A" } },
    { at: 400, names: { B: "C" } },
  ];
  assert.equal(renamedSessionProvider("A", "same", [entry("A", 100)], history), "C");
  assert.equal(renamedSessionProvider("A", "same", [entry("A", 300)], history), "A");
  assert.equal(renamedSessionProvider("B", "same", [entry("B", 300)], history), "C");
  assert.equal(
    renamedSessionProvider(
      "A",
      "same",
      [
        entry("A", 100),
        {
          type: "message",
          timestamp: new Date(500).toISOString(),
          message: { role: "assistant", provider: "A", model: "same" },
        },
      ],
      history,
    ),
    "C",
  );
});

test("the backend rejects ambiguous rename claims and retains its journal across stale editor metadata", () => {
  const old = { providers: { A: {}, B: {} } };
  assert.throws(() => withProviderRenames(old, old, { A: "B" }), /Invalid provider rename/);
  assert.throws(() => withProviderRenames(old, { providers: { C: {} } }, { missing: "C" }), /Invalid provider rename/);
  const next = withProviderRenames(old, { providers: { C: {}, B: {} } }, { A: "C" });
  assert.equal(next._desktopProviderRenames.length, 1);
  assert.deepEqual(
    withProviderRenames(next, { providers: next.providers })._desktopProviderRenames,
    next._desktopProviderRenames,
  );
});

test(
  "saving a rename preserves visibility and lets live and reopened SDK sessions continue without model reselection",
  { timeout: 20000 },
  async (t) => {
    const filename = path.join(root, "models.json");
    const provider = {
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "enabled", reasoning: true }, { id: "disabled" }],
    };
    writeFileSync(filename, JSON.stringify({ providers: { original: provider } }));
    writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({
        enabledModels: ["original/enabled", "other/keep"],
        defaultProvider: "original",
        defaultModel: "enabled",
        cacheWarming: "off",
      }),
    );
    const manager = SessionManager.inMemory(root);
    manager.appendModelChange("original", "enabled");
    manager.appendThinkingLevelChange("minimal");
    const closedManager = SessionManager.inMemory(root);
    closedManager.appendModelChange("original", "enabled");
    const wrappers = [];
    t.after(async () => {
      for (const wrapper of wrappers) await wrapper.dispose();
    });
    const open = async (sessionManager) => {
      const selection = new SessionModelSelection();
      const services = await createDesktopAgentSessionServices({
        cwd: root,
        agentDir: root,
        resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
      });
      const model = selection.prepare(services, sessionManager);
      const { session, modelFallbackMessage } = await createAgentSessionFromServices({
        services,
        sessionManager,
        tools: [],
        ...(model ? { model } : {}),
      });
      selection.finish(session, modelFallbackMessage);
      const wrapper = new AgentSessionWrapper(
        session,
        [],
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        selection,
      );
      wrapper.start();
      wrappers.push(wrapper);
      return { session, wrapper, selection };
    };
    const live = await open(manager);
    await live.wrapper.send({ type: "set_thinking_level", level: "minimal" });
    const initial = await modelConfigHandlers.get();
    const saved = await modelConfigHandlers.set({
      config: { providers: { renamed: provider } },
      expectedVersion: initial.version,
      providerRenames: { original: "renamed" },
    });
    await ensureProviderRenameSettings(root);
    const settings = JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8"));
    assert.deepEqual(settings.enabledModels, ["renamed/enabled", "other/keep"]);
    assert.equal(settings.defaultProvider, "renamed");
    assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")).providers.renamed, provider);
    // An unopened trusted project catches up without requiring a second rename/save.
    const project = path.join(root, "later-project");
    mkdirSync(path.join(project, ".pi"), { recursive: true });
    writeFileSync(
      path.join(project, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["original/enabled"], defaultProvider: "original" }),
    );
    // The project file predates the rename.
    utimesSync(path.join(project, ".pi", "settings.json"), new Date(1000), new Date(1000));
    await ensureProviderRenameSettings(root, project, false);
    assert.equal(
      JSON.parse(readFileSync(path.join(project, ".pi", "settings.json"), "utf8")).defaultProvider,
      "original",
    );
    await ensureProviderRenameSettings(root, project);
    assert.equal(
      JSON.parse(readFileSync(path.join(project, ".pi", "settings.json"), "utf8")).defaultProvider,
      "renamed",
    );
    const reopened = await open(closedManager);
    assert.equal(reopened.session.model.provider, "renamed");
    assert.equal(reopened.selection.snapshot(reopened.session), undefined);
    const send = async (fixture, expected) => {
      const observed = new Promise((resolve) => {
        fixture.session.agent.streamFunction = (model) => {
          resolve(model);
          const stream = createAssistantMessageEventStream();
          const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: "stop",
            content: [{ type: "text", text: "OK" }],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          globalThis.queueMicrotask(() => {
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          });
          return stream;
        };
      });
      await fixture.wrapper.send({ type: "prompt", message: "Continue the original conversation" });
      const model = await observed;
      assert.equal(model.provider, expected);
      assert.equal(model.id, "enabled");
      assert.equal(model.baseUrl, provider.baseUrl);
      await fixture.session.waitForIdle();
    };
    await send(live, "renamed");
    assert.equal(live.session.thinkingLevel, "minimal");
    await send(reopened, "renamed");
    await modelConfigHandlers.set({
      config: { providers: { original: provider } },
      expectedVersion: saved.version,
      providerRenames: { renamed: "original" },
    });
    await ensureProviderRenameSettings(root);
    await send(live, "original");
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8")).enabledModels, [
      "original/enabled",
      "other/keep",
    ]);
    assert.equal(JSON.parse(readFileSync(filename, "utf8"))._desktopProviderRenames.length, 2);
  },
);

const renameFixture = (events) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-provider-renames-files-"));
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {}, _desktopProviderRenames: events }));
  return dir;
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeOld = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  utimesSync(file, new Date(1000), new Date(1000));
};

test("renames migrate Auto routing fast/strong/classifier references", async (t) => {
  const dir = renameFixture([{ at: 2000, names: { gw: "gateway" } }]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routing = {
    enabled: true,
    strategy: "classifier",
    fastThinking: "low",
    strongThinking: "high",
    retryFallback: false,
    fast: { provider: "other", modelId: "small" },
    strong: { provider: "gw", modelId: "big" },
    classifier: { provider: "gw", modelId: "judge" },
  };
  writeOld(path.join(dir, "desktop-routing.json"), routing);
  assert.equal(await ensureProviderRenameSettings(dir), true);
  const migrated = readJson(path.join(dir, "desktop-routing.json"));
  assert.deepEqual(migrated.strong, { provider: "gateway", modelId: "big" });
  assert.deepEqual(migrated.classifier, { provider: "gateway", modelId: "judge" });
  assert.deepEqual(migrated.fast, routing.fast);
  assert.equal(migrateRoutingSettings(migrated, [{ at: 1, names: { gw: "x" } }]), migrated);
});

test("settings without affected references are never rewritten and missing files are not created", async (t) => {
  const dir = renameFixture([{ at: 2000, names: { a: "b" } }]);
  const project = path.join(dir, "project");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projectFile = path.join(project, ".pi", "settings.json");
  writeOld(projectFile, '{"enabledModels":["other/x"]}');
  assert.equal(await ensureProviderRenameSettings(dir, project), false);
  assert.equal(readFileSync(projectFile, "utf8"), '{"enabledModels":["other/x"]}');
  assert.equal(existsSync(path.join(dir, "settings.json")), false);
  assert.equal(existsSync(path.join(dir, "desktop-routing.json")), false);
});

test("each rename applies once per file, skips files written after it, and survives a shortened journal", async (t) => {
  const dir = renameFixture([{ at: 2000, names: { a: "b" } }]);
  const project = path.join(dir, "project");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const global = path.join(dir, "settings.json");
  writeOld(global, { defaultProvider: "a" });
  // A project created after the rename that references a newly created provider named "a".
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "a" }));
  await ensureProviderRenameSettings(dir, project);
  assert.deepEqual(readJson(global), { defaultProvider: "b" });
  assert.equal(readJson(path.join(project, ".pi", "settings.json")).defaultProvider, "a");
  // Re-running, even after the user points global settings at a recreated "a", does not reapply the rename.
  writeFileSync(global, JSON.stringify({ defaultProvider: "a" }));
  utimesSync(global, new Date(1000), new Date(1000));
  await ensureProviderRenameSettings(dir, project);
  assert.equal(readJson(global).defaultProvider, "a");
  // models.json rewritten with a shorter journal: a newer rename still applies.
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: {}, _desktopProviderRenames: [{ at: 3000, names: { a: "c" } }] }),
  );
  await ensureProviderRenameSettings(dir);
  assert.equal(readJson(global).defaultProvider, "c");
  assert.equal(readJson(global)._desktopProviderRenameCount, undefined);
});

test("a broken settings file is skipped without blocking other files or session services", async (t) => {
  const dir = renameFixture([{ at: 2000, names: { a: "b" } }]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeOld(path.join(dir, "settings.json"), "{ not json");
  writeOld(path.join(dir, "desktop-routing.json"), {
    enabled: false,
    strategy: "thinking",
    fastThinking: "low",
    strongThinking: "high",
    retryFallback: false,
    fast: { provider: "a", modelId: "m" },
  });
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await ensureProviderRenameSettings(dir), true);
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), "{ not json");
  assert.equal(readJson(path.join(dir, "desktop-routing.json")).fast.provider, "b");
  assert.equal(warn.mock.callCount(), 1);
  await assert.doesNotReject(
    createDesktopAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
    }),
  );
});

test("legacy in-file rename counters are honoured once and removed", async (t) => {
  const dir = renameFixture([
    { at: 2000, names: { a: "b" } },
    { at: 3000, names: { b: "c" } },
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeOld(path.join(dir, "settings.json"), { defaultProvider: "b", _desktopProviderRenameCount: 1 });
  await ensureProviderRenameSettings(dir);
  assert.deepEqual(readJson(path.join(dir, "settings.json")), { defaultProvider: "c" });
});
