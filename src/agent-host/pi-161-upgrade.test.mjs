import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ProjectTrustStore,
  SettingsManager,
  SessionManager,
  ModelRuntime,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai/session-resources";
import { importTestBundle } from "#test-bundle";

const {
  readNoticeSettings,
  writeNoticeSetting,
  buildSessionHistoryPage,
  implicitSessionModel,
  disposeSdkSession,
  createDesktopAgentSessionServices,
  AgentSessionWrapper,
  captureExecutionOutput,
  needsTranscriptRefresh,
  branchTranscriptNotices,
  bindSessionNotices,
  historyNoticePreferences,
  applyLiveNoticeSettings,
} = await importTestBundle("pi-161-upgrade", {
  packages: "external",
  stdin: {
    loader: "ts",
    resolveDir: import.meta.dirname,
    contents: `
    export * from "./transcript-settings"; export * from "./session-history"; export * from "./new-session-default";
    export * from "./session-dispose"; export * from "./desktop-session-services"; export {AgentSessionWrapper} from "./rpc-manager";
    export {captureExecutionOutput} from "./execution-output"; export {needsTranscriptRefresh,branchTranscriptNotices} from "./transcript-notices";`,
  },
});
function directories(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-161-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, "project"),
    agentDir = path.join(base, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir);
  return { cwd, agentDir };
}
const prefs = { cacheMisses: true, cacheWarming: true, compactionCosts: true, reasoningDrops: true };
test("notice settings migrate on write and read back global and trusted project values independently", async (t) => {
  const { cwd, agentDir } = directories(t),
    file = path.join(agentDir, "settings.json"),
    projectFile = path.join(cwd, ".pi/settings.json");
  const original = JSON.stringify({ showCacheMissNotices: true, unrelated: 18 }),
    project = JSON.stringify({ notices: { reasoningDrops: false } });
  fs.writeFileSync(file, original);
  fs.writeFileSync(projectFile, project);
  const trust = new ProjectTrustStore(agentDir);
  trust.set(cwd, false);
  assert.deepEqual(readNoticeSettings(cwd, { agentDir }).effective, prefs);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  trust.set(cwd, true);
  const saved = await writeNoticeSetting("reasoningDrops", true, cwd, { agentDir });
  assert.equal(saved.global.reasoningDrops, true);
  assert.equal(saved.effective.reasoningDrops, false);
  await Promise.all([
    writeNoticeSetting("cacheMisses", false, cwd, { agentDir }),
    writeNoticeSetting("compactionCosts", false, cwd, { agentDir }),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    notices: { ...prefs, cacheMisses: false, compactionCosts: false },
    unrelated: 18,
  });
  assert.equal(fs.readFileSync(projectFile, "utf8"), project);
  await assert.rejects(writeNoticeSetting("future", false, cwd, { agentDir }), (e) => e.code === "BAD_REQUEST");
  fs.writeFileSync(file, "{bad");
  await assert.rejects(writeNoticeSetting("cacheMisses", true, cwd, { agentDir }));
  assert.equal(fs.readFileSync(file, "utf8"), "{bad");
});
function usage(input = 4000, cacheRead = 0) {
  return {
    input,
    output: 10,
    cacheWrite: 0,
    cacheRead,
    totalTokens: input + cacheRead + 10,
    cost: { input: 0.1, output: 0.03, cacheRead: 0.01, cacheWrite: 0, total: 0.14 },
  };
}
test("history derives the four transcript notices before pagination and keeps them out of stored/model messages", () => {
  let ordinal = 0;
  const entries = [];
  function add(data) {
    const record = {
      id: String(++ordinal),
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(1000 * ordinal).toISOString(),
      ...data,
    };
    entries.push(record);
    return record;
  }
  const assistant = (count, cacheRead = 0) => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6.2-sol",
    timestamp: ordinal * 1000,
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    usage: usage(4000 - cacheRead, cacheRead),
    diagnostics: [
      {
        type: "openai_input_transformations",
        details: {
          transformations: Array.from({ length: count }, () => ({ type: "reasoning", reason: "prefix_mismatch" })),
        },
      },
    ],
  });
  add({ type: "message", message: { role: "user", content: "hello", timestamp: 1 } });
  const a = add({ type: "message", message: assistant(1, 3000) }),
    b = add({ type: "message", message: assistant(1) }),
    c = add({ type: "message", message: assistant(2, 3000) });
  const warm = add({ type: "usage", kind: "cache_warm", provider: "openai", model: "gpt-6.2-sol", usage: usage() });
  const compact = add({
    type: "compaction",
    firstKeptEntryId: c.id,
    summary: "compact",
    tokensBefore: 4000,
    usage: usage(),
  });
  const branch = add({ type: "branch_summary", fromId: c.id, summary: "branch", usage: usage() });
  const original = JSON.stringify(entries);
  for (const historyWindow of [undefined, { maxTurns: 4, maxBytes: 200000 }]) {
    const visible = buildSessionHistoryPage({ entries, historyRevision: "r", historyWindow, noticeSettings: prefs });
    const at = (entry) => visible.messages[visible.entryIds.indexOf(entry.id)]?.transcriptNotices ?? [];
    assert.deepEqual(
      at(a).map((x) => x.kind),
      ["reasoningDrops"],
    );
    assert.deepEqual(
      at(b).map((x) => x.kind),
      ["cacheMisses"],
    );
    assert.equal(at(c)[0].count, 2);
    assert.equal(at(warm)[0].kind, "cacheWarming");
    assert.equal(at(compact)[0].kind, "compactionCosts");
    assert.equal(at(branch)[0].branchSummary, true);
    const other = buildSessionHistoryPage({
      entries,
      leafId: b.id,
      historyRevision: "r",
      historyWindow,
      noticeSettings: { ...prefs, reasoningDrops: false },
    });
    assert.equal(
      other.messages.flatMap((m) => m.transcriptNotices ?? []).some((n) => n.kind === "reasoningDrops"),
      false,
    );
    assert.notEqual(other.historyRevision, visible.historyRevision);
  }
  assert.equal(JSON.stringify(entries), original);

  // Live completions ask for a reread only when the persisted projection will show a new notice there.
  const live = (message, before, notices = prefs) =>
    needsTranscriptRefresh(
      { type: "message_end", message },
      {
        settingsManager: { getNotices: () => notices },
        sessionManager: {
          getLeafEntry: () => before.at(-1),
          getEntry: (id) => before.find((entry) => entry.id === id),
        },
      },
    );
  const prior = (entry) => entries.slice(0, entries.indexOf(entry));
  assert.equal(live(a.message, prior(a)), true, "first reasoning drop");
  assert.equal(live(b.message, prior(b)), true, "cache miss without a new drop");
  assert.equal(live(b.message, prior(b), { ...prefs, cacheMisses: false }), false, "repeated drop count");
  assert.equal(live(c.message, prior(c)), true, "drop count increased");
  assert.equal(live(c.message, [...prior(c), c]), true, "already persisted message is ignored");
  const quiet = assistant(2, 3000);
  assert.equal(live(quiet, entries.slice(0, entries.indexOf(c) + 1)), false, "no new drop and a cache hit");
  assert.equal(live(a.message, prior(a), { ...prefs, cacheMisses: false, reasoningDrops: false }), false);
  const appended = (entry, notices = prefs) =>
    needsTranscriptRefresh({ type: "entry_appended", entry }, { settingsManager: { getNotices: () => notices } });
  assert.equal(appended(warm), true);
  assert.equal(appended(warm, { ...prefs, cacheWarming: false }), false);
  assert.equal(appended(compact), true);
  assert.equal(appended({ ...compact, usage: undefined }), false, "no billed usage, no notice");
});
test("real SDK default and enabled models drive the desktop's offline model preview", async (t) => {
  const { agentDir } = directories(t);
  fs.writeFileSync(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "offline-fixture" } }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.refresh({ allowNetwork: false });
  const settings = SettingsManager.inMemory();
  assert.equal((await implicitSessionModel(runtime, settings)).id, "gpt-6.2-sol");
  settings.setEnabledModels(["openai/gpt-6.1-sol"]);
  assert.equal((await implicitSessionModel(runtime, settings)).id, "gpt-6.1-sol");
});
test("real extension registration diagnostics deduplicate across reload and disappear after repair; closing releases only this session", async (t) => {
  const { cwd, agentDir } = directories(t);
  let broken = true;
  const manager = SessionManager.inMemory(cwd);
  const services = await createDesktopAgentSessionServices(
    {
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: "off",
        enabledModels: ["unconfigured/preview-model", "nvidia/meta/llama-3.2-90b-vision-instruct"],
      }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "broken-provider",
            factory(pi) {
              if (broken) pi.registerProvider("test-broken", { models: [], streamSimple() {} });
            },
          },
        ],
      },
    },
    { sessionManager: manager },
  );
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, tools: [] });
  const wrapper = new AgentSessionWrapper(session, [], () => {});
  const released = [];
  const off = registerSessionResourceCleanup((id) => released.push(id));
  t.after(off);
  try {
    wrapper.setRuntimeDiagnostics(services.diagnostics);
    wrapper.start();
    const statuses = async () =>
      (await wrapper.send({ type: "get_state" })).extensionStatuses.filter((x) => x.key.startsWith("pi-runtime-"));
    const first = await statuses();
    assert.equal(first.length, 1);
    assert.match(first[0].text, /broken-provider/);
    await wrapper.send({ type: "reload" });
    assert.deepEqual(await statuses(), first);
    broken = false;
    await wrapper.send({ type: "reload" });
    assert.deepEqual(await statuses(), []);
  } finally {
    await Promise.all([wrapper.dispose(), wrapper.dispose()]);
  }
  assert.deepEqual(released, [session.sessionId]);
});
test("failed MCP detach cannot suppress provider cleanup or history flush", async () => {
  const steps = [];
  await disposeSdkSession(
    { agent: {}, sessionId: "fixture", dispose: () => steps.push("sdk") },
    { abort: false },
    async () => {
      throw Error("fixture");
    },
    async () => {
      steps.push("history");
    },
  );
  assert.deepEqual(steps, ["sdk", "history"]);
});
test("failed Bash spill preserves an incomplete output reason without manufacturing a file", async () => {
  const r = await captureExecutionOutput({}, "bash", { details: { fullOutputError: "No space left on device" } });
  assert.deepEqual(r, { complete: false, reason: "No space left on device" });
  assert.equal(await captureExecutionOutput({}, "read", { details: { fullOutputError: "ignored" } }), undefined);
});

test("all four desktop extension dialog entries carry the category and a cached render array is snapshotted", async (t) => {
  const { cwd, agentDir } = directories(t);
  let ui;
  const { session } = await createAgentSessionFromServices({
    services: await createDesktopAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
      },
    }),
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  const originalBind = session.bindExtensions.bind(session);
  session.bindExtensions = (bindings) => {
    ui = bindings.uiContext;
    return originalBind(bindings);
  };
  const wrapper = new AgentSessionWrapper(session, [], () => {});
  wrapper.start();
  t.after(() => wrapper.dispose());
  await wrapper.send({ type: "get_tools" });
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  for (const [fn, params, expected] of [
    ["select", ["Choose", ["A"], { blockedKind: "permission" }], "permission"],
    ["confirm", ["Proceed", "Message"], "permission"],
    ["input", ["Login", "", { blockedKind: "auth" }], "auth"],
    [
      "confirmLocalized",
      [
        "Title",
        "Message",
        { id: "mcp.authorize", servers: "s", tools: "t", toolCount: 1 },
        { blockedKind: "question" },
      ],
      "question",
    ],
  ]) {
    const pending = ui[fn](...params);
    const event = events.at(-1);
    assert.equal(event.blockedKind, expected);
    if (fn === "confirmLocalized") assert.equal(event.localization.id, "mcp.authorize");
    await wrapper.send({ type: "extension_ui_response", id: event.id, confirmed: true, value: "A" });
    await pending;
  }
  let done, tui;
  const cached = ["first"];
  const pending = ui.custom((view, _theme, _keymap, close) => {
    tui = view;
    done = close;
    return { render: () => cached };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const first = events.at(-1);
  assert.deepEqual(first.lines, ["first"]);
  cached[0] = "second";
  tui.requestRender();
  assert.deepEqual(first.lines, ["first"]);
  assert.deepEqual(events.at(-1).lines, ["second"]);
  done();
  await pending;
});

test("live notices match history for different messages with the same or absent timestamp", (t) => {
  const { cwd } = directories(t);
  for (const timestamp of [100, undefined]) {
    const manager = SessionManager.inMemory(cwd);
    const copy = (cacheRead, count) => ({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      timestamp,
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: usage(4000 - cacheRead, cacheRead),
      diagnostics: [
        {
          type: "openai_input_transformations",
          details: {
            transformations: Array.from({ length: count }, () => ({ type: "reasoning", reason: "prefix_mismatch" })),
          },
        },
      ],
    });
    manager.appendMessage(copy(3500, 1));
    const finishing = copy(0, 1);
    const live = (enabled) =>
      needsTranscriptRefresh(
        { type: "message_end", message: finishing },
        { settingsManager: { getNotices: () => enabled }, sessionManager: manager },
      );
    const dropOnly = { ...prefs, cacheMisses: false },
      cacheOnly = { ...prefs, reasoningDrops: false };
    assert.equal(live(dropOnly), false);
    assert.equal(live(cacheOnly), true);
    const id = manager.appendMessage(finishing);
    for (const enabled of [dropOnly, cacheOnly]) {
      assert.equal(live(enabled), branchTranscriptNotices(manager.getBranch(), enabled).has(id));
    }
  }
});

test("the live cache tracks appended entries, compaction, and switching branches without rescanning each turn", (t) => {
  const { cwd } = directories(t),
    manager = SessionManager.inMemory(cwd);
  const quiet = { ...prefs, reasoningDrops: false };
  let reads = 0,
    walks = 0;
  const source = {
    settingsManager: {
      getNotices() {
        reads++;
        return quiet;
      },
    },
    sessionManager: {
      getLeafEntry: () => manager.getLeafEntry(),
      getEntry(id) {
        walks++;
        return manager.getEntry(id);
      },
    },
  };
  for (let i = 0; i < 100; i++) needsTranscriptRefresh({ type: "message_update" }, source);
  assert.equal(reads, 0);
  const assistant = (input, read) => ({
    role: "assistant",
    provider: "openai",
    model: "fixture",
    api: "openai-responses",
    timestamp: 1,
    stopReason: "stop",
    content: [{ type: "text", text: "fixture" }],
    usage: usage(input, read),
  });
  const root = manager.appendMessage({ role: "user", content: "question", timestamp: 0 });
  function complete(message) {
    const live = needsTranscriptRefresh({ type: "message_end", message }, source);
    const entryId = manager.appendMessage(message);
    assert.equal(live, branchTranscriptNotices(manager.getBranch(), quiet).has(entryId));
    return entryId;
  }
  for (let i = 0; i < 60; i++) complete(assistant(4000, 0));
  assert.ok(walks <= 65, "appending a single entry should traverse only the new part of the branch");
  const cached = complete(assistant(200, 3800));
  complete(assistant(4000, 0));
  complete(assistant(4000, 0));
  manager.appendCompaction("summary", cached, 4000);
  complete(assistant(4000, 0));
  manager.branch(root);
  complete(assistant(4000, 0));
  manager.appendUsage("cache_warm", "openai", "fixture", usage(4000));
  complete(assistant(4000, 0));
});

test("synchronized notices survive unrelated SDK saves without hot-applying unrelated disk settings", async (t) => {
  const { cwd, agentDir } = directories(t),
    file = path.join(agentDir, "settings.json"),
    project = path.join(cwd, ".pi/settings.json");
  fs.writeFileSync(file, JSON.stringify({ retry: { maxRetries: 1 }, notices: { reasoningDrops: false } }));
  fs.writeFileSync(project, JSON.stringify({ notices: { cacheMisses: false } }));
  const trust = new ProjectTrustStore(agentDir);
  trust.set(cwd, true);
  const a = SettingsManager.create(cwd, agentDir),
    b = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const sessions = [a, b].map((settingsManager, i) => ({
    sessionId: String(i),
    cwd,
    isAlive: () => true,
    inner: { settingsManager },
  }));
  for (const s of [a, b]) bindSessionNotices(s, cwd, agentDir);
  fs.writeFileSync(
    file,
    JSON.stringify({ retry: { maxRetries: 7 }, notices: { reasoningDrops: true, cacheMisses: true }, futureKey: 9 }),
  );
  const saved = fs.readFileSync(file, "utf8");
  a.applyOverrides({ retry: { maxRetries: 3 } });
  applyLiveNoticeSettings(sessions);
  assert.equal(fs.readFileSync(file, "utf8"), saved, "synchronizing live sessions must not rewrite the CLI file");
  assert.equal(a.getNotices().cacheMisses, false);
  assert.equal(b.getNotices().cacheMisses, true);
  assert.equal(a.getRetrySettings().maxRetries, 3, "synchronization preserves unrelated in-memory overrides");
  a.setCacheWarmingMode("off");
  await a.flush();
  assert.equal(a.getRetrySettings().maxRetries, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).retry.maxRetries, 7);
  assert.equal(a.getNotices().reasoningDrops, true);
  assert.equal(a.getSettings().notices.reasoningDrops, true);
  assert.equal(Object.hasOwn(a.getSettings().notices, "compactionCosts"), false);
  assert.deepEqual(historyNoticePreferences(cwd, a), a.getNotices());
  a.getNotices().reasoningDrops = false;
  assert.equal(a.getNotices().reasoningDrops, true);
  a.setNotice("reasoningDrops", false);
  assert.equal(a.getNotices().reasoningDrops, false);
  await a.flush();
  a.setProjectTrusted(false);
  assert.equal(a.getNotices().cacheMisses, true);
  await a.reload();
  assert.equal(a.getRetrySettings().maxRetries, 7);
  assert.equal(a.getNotices().reasoningDrops, false);
  assert.equal(JSON.parse(fs.readFileSync(file)).futureKey, 9);
  const empty = path.join(agentDir, "empty-agent");
  fs.mkdirSync(empty);
  const withDefaults = SettingsManager.create(cwd, empty, { projectTrusted: false });
  bindSessionNotices(withDefaults, cwd, empty);
  assert.equal(withDefaults.getSettings().notices, undefined);
  await writeNoticeSetting("cacheMisses", false, undefined, { agentDir: empty });
  bindSessionNotices(withDefaults, cwd, empty);
  assert.deepEqual(withDefaults.getSettings().notices, { cacheMisses: false });
  a.setNotice("cacheWarming", true);
  await a.flush();
  fs.writeFileSync(file, "{damaged");
  await a.reload();
  assert.equal(a.getNotices().cacheMisses, true, "a failed reload keeps the last valid global notices");
  assert.equal(a.getNotices().cacheWarming, true, "a direct SDK update is also last known good");
  assert.ok(a.drainErrors().some((error) => error.scope === "global"));
});

test("a broken project reports its own read failure while the global notice save still succeeds", async (t) => {
  const { cwd, agentDir } = directories(t),
    global = path.join(agentDir, "settings.json"),
    project = path.join(cwd, ".pi/settings.json");
  fs.writeFileSync(global, JSON.stringify({ notices: { reasoningDrops: false }, other: 2 }));
  fs.writeFileSync(project, "{broken");
  const scope = { agentDir, sessionTrusted: true, reportErrors: true };
  const opened = readNoticeSettings(cwd, scope);
  assert.equal(opened.projectLoadFailed, true);
  assert.equal(opened.global.reasoningDrops, false);
  const saved = await writeNoticeSetting("reasoningDrops", true, cwd, scope);
  assert.equal(saved.projectLoadFailed, true);
  assert.equal(saved.global.reasoningDrops, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(global)), { notices: { reasoningDrops: true }, other: 2 });
  assert.equal(fs.readFileSync(project, "utf8"), "{broken");
  fs.writeFileSync(project, "{}");
  const pending = writeNoticeSetting("cacheMisses", true, cwd, scope);
  fs.writeFileSync(project, "{broken-again");
  const raced = await pending;
  assert.equal(raced.global.cacheMisses, true);
  assert.equal(raced.projectLoadFailed, true);
  assert.equal(fs.readFileSync(project, "utf8"), "{broken-again");
});

test(
  "stopping an extension command denies its pending and subsequent prompts and allows a fresh command",
  { timeout: 8_000 },
  async (t) => {
    const { cwd, agentDir } = directories(t);
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture",
            models: [
              {
                id: "offline",
                name: "Offline",
                input: ["text"],
                reasoning: false,
                contextWindow: 8192,
                maxTokens: 512,
              },
            ],
          },
        },
      }),
    );
    const replies = [];
    const services = await createDesktopAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "permission lifecycle",
            factory(pi) {
              pi.registerCommand("confirm-twice", {
                description: "Permission lifecycle",
                handler: async (_args, ctx) => {
                  replies.push(await ctx.ui.confirm("First", "Permit?", { timeout: 35000 }));
                  replies.push(await ctx.ui.confirm("Second", "Permit?", { timeout: 35000 }));
                },
              });
            },
          },
        ],
      },
    });
    const model = services.modelRuntime.getModel("fixture", "offline");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({
      services,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [],
    });
    const wrapper = new AgentSessionWrapper(session);
    wrapper.start();
    t.after(() => wrapper.dispose());
    const opened = Promise.withResolvers(),
      firstDone = Promise.withResolvers(),
      nextDone = Promise.withResolvers();
    let confirming = false;
    const titles = [];
    wrapper.onEvent((e) => {
      if (e.type === "prompt_error") (confirming ? nextDone : opened).reject(new Error(e.errorMessage));
      if (e.type === "extension_ui_request" && e.method === "confirm") {
        titles.push(e.title);
        if (confirming) void wrapper.send({ type: "extension_ui_response", id: e.id, confirmed: true });
        else opened.resolve(e);
      }
      if (e.type === "prompt_done") (confirming ? nextDone : firstDone).resolve();
    });
    await wrapper.send({ type: "prompt", message: "/confirm-twice" });
    const first = await opened.promise;
    assert.equal((await wrapper.send({ type: "get_state" })).pendingDialogs[0].id, first.id);
    await wrapper.send({ type: "abort" });
    await firstDone.promise;
    assert.deepEqual(replies, [false, false]);
    assert.deepEqual(titles, ["First"]);
    await wrapper.send({ type: "extension_ui_response", id: first.id, confirmed: true });
    confirming = true;
    await wrapper.send({ type: "prompt", message: "/confirm-twice" });
    await nextDone.promise;
    assert.deepEqual(replies, [false, false, true, true]);
    assert.deepEqual((await wrapper.send({ type: "get_state" })).pendingDialogs, []);
  },
);
