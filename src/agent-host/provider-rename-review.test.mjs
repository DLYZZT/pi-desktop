import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import lockfile from "proper-lockfile";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";

process.env.PI_OFFLINE = "1";
const {
  ensureProviderRenameSettings,
  createAutoRoutingExtension,
  markModelConfigChanged,
  createDesktopAgentSessionServices,
  SessionModelSelection,
  AgentSessionWrapper,
} = await importTestBundle("provider-rename-review", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {ensureProviderRenameSettings} from './provider-renames.ts';
    export {createAutoRoutingExtension} from './auto-routing.ts';
    export {markModelConfigChanged} from './model-config-revision.ts';
    export {createDesktopAgentSessionServices} from './desktop-session-services.ts';
    export {SessionModelSelection} from './session-model-selection.ts';
    export {AgentSessionWrapper} from './rpc-manager.ts';
  `,
  },
});

test(
  "a live SDK Auto session sends its next turn to the renamed physical provider without reselection",
  { timeout: 10000 },
  async (t) => {
    const dir = fixture(t, []);
    const provider = {
      api: "openai-completions",
      apiKey: "synthetic",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [
        { id: "fast", reasoning: true },
        { id: "strong", reasoning: true },
      ],
    };
    writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { old: provider } }));
    oldFile(path.join(dir, "desktop-routing.json"), routing("thinking"));
    oldFile(path.join(dir, "settings.json"), { cacheWarming: "off", retry: { enabled: false } });
    const manager = SessionManager.inMemory(dir);
    manager.appendModelChange("pi-desktop-router", "auto");
    manager.appendMessage({ role: "user", content: "Existing Auto conversation", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "old",
      model: "fast",
      timestamp: 2,
      stopReason: "stop",
      content: [{ type: "text", text: "Previous reply" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const selection = new SessionModelSelection();
    const services = await createDesktopAgentSessionServices(
      {
        cwd: dir,
        agentDir: dir,
        resourceLoaderOptions: { noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true },
      },
      { sessionManager: manager },
    );
    selection.prepare(services, manager);
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      tools: [],
    });
    await session.bindExtensions({ mode: "rpc" });
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
    t.after(() => wrapper.dispose());
    await wrapper.send({ type: "set_thinking_level", level: "low" });
    const send = async (expected) => {
      const observed = new Promise((resolve) => {
        session.agent.streamFunction = (model) => {
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
      await wrapper.send({ type: "prompt", message: "Continue Auto conversation" });
      const actual = await observed;
      assert.equal(actual.provider, expected);
      assert.equal(actual.id, "fast");
      await session.waitForIdle();
      assert.equal(session.model.provider, "pi-desktop-router");
    };
    await send("old");
    writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: { new: provider },
        _desktopProviderRenames: [{ at: Date.now() + 1, names: { old: "new" } }],
      }),
    );
    await ensureProviderRenameSettings(dir);
    markModelConfigChanged();
    await send("new");
  },
);

function fixture(t, events = [{ at: 2000, names: { old: "new" } }]) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-rename-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {}, _desktopProviderRenames: events }));
  return dir;
}
function oldFile(filename, text) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof text === "string" ? text : JSON.stringify(text));
  utimesSync(filename, 1, 1);
}
const read = (filename) => JSON.parse(readFileSync(filename, "utf8"));
const routing = (strategy) => ({
  enabled: true,
  strategy,
  retryFallback: true,
  fastThinking: "low",
  strongThinking: "high",
  fast: { provider: "old", modelId: "fast" },
  strong: { provider: "old", modelId: "strong" },
  classifier: { provider: "old", modelId: "judge" },
});

for (const strategy of ["thinking", "classifier"])
  test(`a loaded Auto extension continues after rename and uses ${strategy} routing`, async (t) => {
    const dir = fixture(t, []);
    oldFile(path.join(dir, "desktop-routing.json"), routing(strategy));
    const clock = t.mock.method(Date, "now", () => 1000);
    let virtual;
    const usage = [];
    createAutoRoutingExtension(dir, (provider, id) => usage.push({ provider, id })).factory({
      registerVirtualModel(value) {
        virtual = value;
      },
    });
    clock.mock.restore();
    let current = "old";
    let classified = 0;
    const ctx = {
      modelRegistry: {
        find: (provider, id) => (provider === current ? { provider, id, api: "openai-completions" } : undefined),
        findOfType: (type, provider, id) =>
          type === "classifier" && provider === current ? { provider, id } : undefined,
        classify: async (model) => {
          classified++;
          assert.equal(model.provider, current);
          return {
            stopReason: "stop",
            answers: { complexity: { type: "choice", probabilities: { complex: 0.1, simple: 0.9 } } },
            usage: {},
          };
        },
      },
    };
    const request = {
      reason: "user",
      thinkingLevel: "low",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    assert.equal((await virtual.route(request, ctx)).model.provider, "old");
    writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: {}, _desktopProviderRenames: [{ at: 2000, names: { old: "new" } }] }),
    );
    await ensureProviderRenameSettings(dir);
    markModelConfigChanged();
    current = "new";
    const next = await virtual.route(request, ctx);
    assert.equal(next.model.provider, "new");
    assert.equal(next.model.id, "fast");
    if (strategy === "classifier") {
      assert.equal(classified, 2, "classifier must run rather than silently falling back to strong");
      assert.deepEqual(usage.at(-1), { provider: "new", id: "judge" });
    } else assert.equal((await virtual.route({ ...request, thinkingLevel: "high" }, ctx)).model.id, "strong");
  });

test("an unaffected project retains bytes, modification time and permissions without private fields", async (t) => {
  const dir = fixture(t);
  const project = path.join(dir, "project");
  const filename = path.join(project, ".pi", "settings.json");
  oldFile(filename, '{ "enabledModels": ["other/model"], "custom": 17 }\n');
  chmodSync(filename, 0o644);
  const before = statSync(filename);
  const raw = readFileSync(filename, "utf8");
  await ensureProviderRenameSettings(dir, project);
  assert.equal(readFileSync(filename, "utf8"), raw);
  assert.equal(statSync(filename).mtimeMs, before.mtimeMs);
  assert.equal(statSync(filename).mode & 0o777, before.mode & 0o777);
  assert.equal(existsSync(path.join(dir, "settings.json")), false);
});

for (const content of ["", "{invalid-json"])
  test(`session services tolerate ${content ? "invalid" : "empty"} settings during migration`, async (t) => {
    const dir = fixture(t);
    const filename = path.join(dir, "settings.json");
    oldFile(filename, content);
    t.mock.method(console, "warn", () => {});
    await assert.doesNotReject(
      createDesktopAgentSessionServices({
        cwd: dir,
        agentDir: dir,
        resourceLoaderOptions: { noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true },
      }),
    );
    assert.equal(readFileSync(filename, "utf8"), content);
  });

test("a migration lock failure leaves session creation available", async (t) => {
  const dir = fixture(t);
  const filename = path.join(dir, "settings.json");
  oldFile(filename, { defaultProvider: "old" });
  const originalLock = lockfile.lock;
  t.mock.method(lockfile, "lock", async (file, options) => {
    if (file === filename) throw Object.assign(Error("fixture lock failure"), { code: "EACCES" });
    return originalLock(file, options);
  });
  t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(
    createDesktopAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: { noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true },
    }),
  );
  assert.equal(read(filename).defaultProvider, "old");
});

test("retrying after migration progress cannot be saved must not apply a provider swap twice", async (t) => {
  const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
  const settings = path.join(dir, "settings.json");
  const state = path.join(dir, "desktop-provider-renames.json");
  oldFile(settings, { defaultProvider: "a", enabledModels: ["a/model"] });
  oldFile(state, { files: { [settings]: 1000 } });
  const fault = failProgressCommit(t, state);
  t.mock.method(console, "warn", () => {});
  assert.equal(
    await ensureProviderRenameSettings(dir),
    true,
    "the committed settings must be reloaded even if progress fails",
  );
  assert.equal(read(settings).defaultProvider, "b");
  assert.ok(read(state).pending[settings]);
  await ensureProviderRenameSettings(dir);
  assert.equal(read(settings).defaultProvider, "b", "repeated progress failures must not repeat the swap");
  fault.restore();
  await ensureProviderRenameSettings(dir);
  assert.equal(read(settings).defaultProvider, "b", "a retry must keep the already migrated provider identity");
  assert.deepEqual(read(settings).enabledModels, ["b/model"]);
  assert.equal(read(state).pending, undefined);
  assert.equal(read(state).files[settings], 2000);
});

function failProgressCommit(t, state) {
  const originalOpen = fsPromises.open;
  let writes = 0;
  const mock = t.mock.method(fsPromises, "open", async (file, ...args) => {
    if (String(file).startsWith(state + ".") && ++writes > 1)
      throw Object.assign(Error("fixture progress commit failure"), { code: "ENOSPC" });
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  const restore = () => {
    mock.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { restore };
}

test("unavailable progress storage prevents any target write until it is available", async (t) => {
  const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
  const settings = path.join(dir, "settings.json"),
    state = path.join(dir, "desktop-provider-renames.json");
  oldFile(settings, '{ "defaultProvider": "a", "enabledModels": ["a/model"] }\n');
  const before = readFileSync(settings, "utf8");
  const originalLock = lockfile.lock;
  const denied = t.mock.method(lockfile, "lock", async (file, options) => {
    if (file === state) throw Object.assign(Error("fixture journal unavailable"), { code: "EACCES" });
    return originalLock(file, options);
  });
  t.mock.method(console, "warn", () => {});
  assert.equal(await ensureProviderRenameSettings(dir), false);
  assert.equal(readFileSync(settings, "utf8"), before);
  denied.mock.restore();
  await ensureProviderRenameSettings(dir);
  assert.equal(read(settings).defaultProvider, "b");
});

test("an interrupted target write recovers its original operation before a newer rename", async (t) => {
  const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
  const settings = path.join(dir, "settings.json"),
    state = path.join(dir, "desktop-provider-renames.json");
  oldFile(settings, { defaultProvider: "a", enabledModels: ["a/model"] });
  const originalOpen = fsPromises.open;
  const denied = t.mock.method(fsPromises, "open", async (file, ...args) => {
    if (String(file).startsWith(settings + "."))
      throw Object.assign(Error("fixture target write failure"), { code: "ENOSPC" });
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    denied.mock.restore();
    syncBuiltinESMExports();
  });
  t.mock.method(console, "warn", () => {});
  assert.equal(await ensureProviderRenameSettings(dir), false);
  assert.equal(read(settings).defaultProvider, "a");
  assert.ok(read(state).pending[settings]);
  denied.mock.restore();
  syncBuiltinESMExports();
  // Even if the original journal is replaced, the prepared operation remains recoverable.
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: {}, _desktopProviderRenames: [{ at: 3000, names: { b: "c" } }] }),
  );
  await ensureProviderRenameSettings(dir);
  assert.deepEqual(read(settings), { defaultProvider: "c", enabledModels: ["c/model"] });
  assert.equal(read(state).files[settings], 3000);
  assert.equal(read(state).pending, undefined);
});

for (const conflict of [false, true])
  test(`progress recovery ${conflict ? "preserves conflicting reference edits" : "preserves unrelated edits without copying secrets"}`, async (t) => {
    const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
    const settings = path.join(dir, "settings.json"),
      state = path.join(dir, "desktop-provider-renames.json");
    oldFile(settings, { defaultProvider: "a", enabledModels: ["a/model"], apiKey: "SYNTHETIC_SECRET_MARKER" });
    const fault = failProgressCommit(t, state);
    t.mock.method(console, "warn", () => {});
    await ensureProviderRenameSettings(dir);
    fault.restore();
    const edited = { ...read(settings), skills: ["user-edited"] };
    if (conflict) edited.defaultProvider = "manual-choice";
    writeFileSync(settings, JSON.stringify(edited));
    const before = readFileSync(settings, "utf8");
    await ensureProviderRenameSettings(dir);
    assert.equal(readFileSync(settings, "utf8"), before);
    assert.equal(readFileSync(state, "utf8").includes("SYNTHETIC_SECRET_MARKER"), false);
    assert.equal(Boolean(read(state).pending?.[settings]), conflict);
  });

test("concurrent migration callers apply a swap only once", async (t) => {
  const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
  const settings = path.join(dir, "settings.json");
  oldFile(settings, { defaultProvider: "a", enabledModels: ["a/model"] });
  const originalOpen = fsPromises.open;
  let targetWrites = 0;
  const observed = t.mock.method(fsPromises, "open", async (file, ...args) => {
    if (String(file).startsWith(settings + ".")) targetWrites++;
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    observed.mock.restore();
    syncBuiltinESMExports();
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => ensureProviderRenameSettings(dir)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(targetWrites, 1);
  assert.equal(read(settings).defaultProvider, "b");
});

test("Auto routing references also survive a failed progress commit and retry", async (t) => {
  const dir = fixture(t, [{ at: 2000, names: { a: "b", b: "a" } }]);
  const file = path.join(dir, "desktop-routing.json"),
    state = path.join(dir, "desktop-provider-renames.json");
  oldFile(file, {
    ...routing("classifier"),
    fast: { provider: "a", modelId: "fast" },
    strong: { provider: "b", modelId: "strong" },
    classifier: { provider: "a", modelId: "judge" },
  });
  const fault = failProgressCommit(t, state);
  t.mock.method(console, "warn", () => {});
  await ensureProviderRenameSettings(dir);
  const expected = read(file);
  assert.equal(expected.fast.provider, "b");
  assert.equal(expected.strong.provider, "a");
  assert.equal(expected.classifier.provider, "b");
  fault.restore();
  await ensureProviderRenameSettings(dir);
  assert.deepEqual(read(file), expected);
});
