import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";

const root = path.resolve(import.meta.dirname, "..", "..");
const isolatedAgentDirectory = mkdtempSync(path.join(tmpdir(), "pi-handler-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolatedAgentDirectory, "sessions");
process.env.PI_OFFLINE = "1";
test.after(() => rmSync(isolatedAgentDirectory, { recursive: true, force: true }));
let modulePromise;

async function loadHandlersModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/agent-host/handlers", {
      packages: "external",
      absWorkingDir: root,
      entryPoints: ["src/agent-host/handlers.ts"],
    });
  })();
  return modulePromise;
}

async function captureHandlers() {
  const { registerHandlers } = await loadHandlersModule();
  const handlers = {};
  const events = [];
  registerHandlers({
    handle(next) {
      Object.assign(handlers, next);
    },
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  });
  return { handlers, events };
}

test("registerHandlers exposes every contract method exactly once", async () => {
  const { handlers } = await captureHandlers();
  // Keep in sync with src/contract/api.ts: one handler per contract method.
  assert.equal(Object.keys(handlers).length, 71);
  for (const method of [
    "host.ping",
    "host.toolchain",
    "sessions.list",
    "sessions.contextPage",
    "sessions.entryContent",
    "worktrees.list",
    "git.status",
    "agent.state",
    "channels.list",
    "channels.accountConnect",
    "files.list",
    "files.download",
    "models.list",
    "models.refresh",
    "models.refreshCancel",
    "models.preferences.get",
    "models.preferences.set",
    "auth.providers",
    "skills.list",
    "plugins.list",
    "system.allowRoot",
  ]) {
    assert.equal(typeof handlers[method], "function", `${method} must be registered`);
  }
});

test("agent.new uses a unique temporary lock key for every request", async () => {
  const { createAgentNewLockKey } = await loadHandlersModule();
  const keys = Array.from({ length: 1_000 }, () => createAgentNewLockKey());

  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => /^__new__[0-9a-f-]{36}$/.test(key)));
});

test("auto-title keeps the local fallback when service creation fails", async () => {
  const { generateSessionTitleWithFallback } = await loadHandlersModule();
  const title = await generateSessionTitleWithFallback(async () => {
    throw new Error("project resources unavailable");
  }, "  Fix\n the login page  ");

  assert.equal(title, "Fix the login page");
});

test("conditional auto-title writes never replace a manual session name", async (t) => {
  const fixtureDirectory = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "auto-title-fixture");
  mkdirSync(fixtureDirectory, { recursive: true });
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

  const createFixture = (sessionId) => {
    const sessionPath = path.join(fixtureDirectory, `2026-08-16T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-16T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf8",
    );
    return sessionPath;
  };

  const guardedSessionId = "auto-title-guarded";
  const guardedPath = createFixture(guardedSessionId);
  const concurrentSessionId = "auto-title-concurrent";
  const concurrentPath = createFixture(concurrentSessionId);
  const { handlers } = await captureHandlers();
  const { applySessionNameIfEmpty } = await loadHandlersModule();

  // Populate the session id → path cache used by the handlers.
  await handlers["sessions.list"]();

  assert.equal(await applySessionNameIfEmpty(guardedSessionId, "Automatic title"), true);
  await handlers["sessions.rename"]({ id: guardedSessionId, name: "Manual title" });
  assert.equal(await applySessionNameIfEmpty(guardedSessionId, "Late automatic title"), false);
  assert.equal(SessionManager.open(guardedPath).getSessionName(), "Manual title");

  await Promise.all([
    applySessionNameIfEmpty(concurrentSessionId, "Automatic title"),
    handlers["sessions.rename"]({ id: concurrentSessionId, name: "Concurrent manual title" }),
  ]);
  assert.equal(SessionManager.open(concurrentPath).getSessionName(), "Concurrent manual title");
});

test("channel initialization failure is reported without an unhandled rejection", async () => {
  const { initializeChannels } = await loadHandlersModule();
  const reports = [];
  initializeChannels(
    {
      async initialize() {
        throw new Error("media init failed?token=sensitive-token");
      },
    },
    (message) => reports.push(message),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports, ["media init failed?token=[REDACTED]"]);
});

test("credential mutation failures distinguish committed state from an unverified mutation", async () => {
  const { credentialMutationFailure } = await loadHandlersModule();
  const synchronizationError = new CredentialSynchronizationError("test-provider", "setRuntimeApiKey", undefined, {
    cause: new Error("secret upstream detail"),
  });

  const committed = await credentialMutationFailure(
    {
      async listCredentials() {
        return [{ providerId: "test-provider", type: "api_key" }];
      },
      async refresh() {
        throw new Error("secret retry detail");
      },
    },
    "test-provider",
    { present: true, type: "api_key" },
    synchronizationError,
  );
  assert.deepEqual(committed, {
    ok: true,
    synchronized: false,
    warning: {
      code: "MODEL_SYNC_FAILED",
      message: "Credentials were updated, but the local model state could not be refreshed. Retry model refresh.",
    },
  });
  assert.doesNotMatch(JSON.stringify(committed), /secret/);

  await assert.rejects(
    credentialMutationFailure(
      {
        async listCredentials() {
          return [];
        },
        async refresh() {
          throw new Error("must not refresh");
        },
      },
      "test-provider",
      { present: true, type: "api_key" },
      synchronizationError,
    ),
    (error) => error?.code === "INTERNAL" && !String(error?.message).includes("secret"),
  );
});

test("model list projection isolates provider availability failures and keeps the last known state", async () => {
  const { projectModelsList } = await loadHandlersModule();
  const goodModel = { id: "fresh", name: "Fresh model", provider: "good", reasoning: false };
  const cachedModel = { id: "cached", name: "Cached model", provider: "broken", reasoning: false };
  const result = await projectModelsList(
    {
      getProviders() {
        return [{ id: "good" }, { id: "broken" }];
      },
      getAvailableSnapshot() {
        return [cachedModel];
      },
      async getAvailable(providerId) {
        if (providerId === "good") return [goodModel];
        throw new Error("secret provider failure detail");
      },
    },
    {
      getEnabledModels() {
        return undefined;
      },
      getDefaultProvider() {
        return undefined;
      },
      getDefaultModel() {
        return undefined;
      },
    },
    { source: "network", refreshed: true, aborted: false, warnings: [] },
  );

  assert.deepEqual(result.models.map((model) => `${model.provider}/${model.id}`).sort(), [
    "broken/cached",
    "good/fresh",
  ]);
  assert.deepEqual(result.catalog.warnings, [
    {
      provider: "broken",
      code: "PROVIDER_AVAILABILITY_FAILED",
      message: "Unable to check broken model availability; the last known state remains available.",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret provider failure detail/);
});

test("file, git, worktree, skill, plugin, and system handlers return contract-shaped results", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-handler-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  mkdirSync(path.join(project, "nested"), { recursive: true });
  const textFile = path.join(project, "hello.txt");
  writeFileSync(textFile, "hello handler tests\n");
  const outsideFile = path.join(base, "outside.txt");
  writeFileSync(outsideFile, "must not become an allowed root\n");

  const { handlers } = await captureHandlers();
  assert.deepEqual(await handlers["system.allowRoot"]({ path: project }), { ok: true });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: project }), { ok: true, path: project });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: outsideFile }), {
    ok: false,
    error: "Not a directory",
  });
  await assert.rejects(
    handlers["system.allowRoot"]({ path: outsideFile }),
    (error) => error.code === "BAD_REQUEST" && /Not a directory/.test(error.message),
  );
  await assert.rejects(
    handlers["system.allowRoot"]({ path: path.join(base, "missing") }),
    (error) => error.code === "BAD_REQUEST" && /Directory does not exist/.test(error.message),
  );

  const listed = await handlers["files.list"]({ path: project });
  assert.equal(
    listed.entries.some((entry) => entry.name === "hello.txt" && entry.type === "file"),
    true,
  );

  const read = await handlers["files.read"]({ path: textFile });
  assert.equal(read.encoding, "utf8");
  assert.equal(read.content, "hello handler tests\n");

  const downloaded = await handlers["files.download"]({ path: textFile });
  assert.equal(Buffer.from(downloaded.base64, "base64").toString("utf8"), "hello handler tests\n");
  assert.equal(downloaded.size, Buffer.byteLength("hello handler tests\n"));

  const oversizedFile = path.join(project, "oversized.bin");
  writeFileSync(oversizedFile, "");
  truncateSync(oversizedFile, 50 * 1024 * 1024 + 1);
  await assert.rejects(
    handlers["files.download"]({ path: oversizedFile }),
    (error) =>
      error.code === "RESULT_TOO_LARGE" &&
      error.detail?.size === 50 * 1024 * 1024 + 1 &&
      error.detail?.maxBytes === 50 * 1024 * 1024,
  );

  const meta = await handlers["files.meta"]({ path: textFile });
  assert.equal(meta.language, "text");
  assert.equal(meta.mime, "text/plain");

  const preview = await handlers["files.preview"]({ path: textFile });
  assert.equal(preview.kind, "text");
  assert.equal(preview.content, "hello handler tests\n");

  const index = await handlers["files.index"]({ root: project, query: "hello" });
  assert.equal(Array.isArray(index.files), true);
  assert.equal(index.files.includes("hello.txt"), true);

  let deepDirectory = project;
  for (let depth = 0; depth < 9; depth += 1) {
    deepDirectory = path.join(deepDirectory, `depth-${depth}`);
    mkdirSync(deepDirectory);
  }
  writeFileSync(path.join(deepDirectory, "beyond-depth.txt"), "too deep", "utf8");
  const depthLimitedIndex = await handlers["files.index"]({ root: project });
  assert.equal(
    depthLimitedIndex.files.includes(
      "depth-0/depth-1/depth-2/depth-3/depth-4/depth-5/depth-6/depth-7/depth-8/beyond-depth.txt",
    ),
    false,
  );
  assert.equal(depthLimitedIndex.truncated, true);
  assert.equal(depthLimitedIndex.truncatedReason, "depth");

  const git = await handlers["git.status"]({ path: project });
  assert.equal(git.isGit, false);

  const worktrees = await handlers["worktrees.list"]({ projectRoot: project });
  assert.equal(Array.isArray(worktrees.worktrees), true);
  assert.equal(worktrees.projectRoot, project);

  const agentState = await handlers["agent.state"]({ sessionId: "missing-session" });
  assert.deepEqual(agentState, { running: false });

  const skills = await handlers["skills.list"]({ cwd: project });
  assert.equal(Array.isArray(skills.skills), true);

  const plugins = await handlers["plugins.list"]({ cwd: project });
  assert.equal(typeof plugins, "object");

  const running = await handlers["system.runningCount"]();
  assert.equal(running.count, running.sessionIds.length);

  await handlers["files.watchStart"]({ path: project });
  assert.deepEqual(await handlers["files.watchStop"]({ path: project }), { ok: true });
});

test("session, model configuration, and auth handlers isolate state and preserve error codes", async () => {
  const { handlers } = await captureHandlers();

  const sessions = await handlers["sessions.list"]();
  assert.deepEqual(sessions.sessions, []);
  assert.deepEqual(sessions.runningSessionIds, []);

  await assert.rejects(handlers["sessions.get"]({ id: "missing" }), (error) => error.code === "NOT_FOUND");
  await assert.rejects(handlers["agent.command"]({ sessionId: "missing", command: { type: "abort" } }), (error) =>
    ["NOT_FOUND", "BAD_REQUEST"].includes(error.code),
  );

  const initialModels = await handlers["modelsConfig.get"]();
  assert.deepEqual(initialModels.config, { providers: {} });
  assert.equal(initialModels.version, "missing");
  await assert.rejects(handlers["modelsConfig.set"]({}), (error) => error.code === "BAD_REQUEST");
  await assert.rejects(
    handlers["modelsConfig.set"]({ config: { providers: {} } }),
    (error) => error.code === "BAD_REQUEST",
  );
  const firstSave = await handlers["modelsConfig.set"]({
    config: { providers: {} },
    expectedVersion: initialModels.version,
  });
  assert.equal(firstSave.ok, true);
  assert.match(firstSave.version, /^sha256:/);

  const v084Config = {
    providers: {
      custom: {
        headers: { Authorization: "Bearer test", "X-Remove-Me": null },
        models: [
          {
            id: "model-one",
            samplingParams: { temperature: 0.2, thinking_token_budget: 1024 },
            futureField: { preserved: true },
          },
        ],
      },
    },
    futureTopLevel: "preserved",
  };
  const editorOne = await handlers["modelsConfig.get"]();
  const editorTwo = await handlers["modelsConfig.get"]();
  const winningSave = await handlers["modelsConfig.set"]({
    config: v084Config,
    expectedVersion: editorOne.version,
  });
  assert.equal(winningSave.ok, true);
  assert.notEqual(winningSave.version, editorOne.version);
  await assert.rejects(
    handlers["modelsConfig.set"]({
      config: { providers: { stale: { api: "openai-completions" } } },
      expectedVersion: editorTwo.version,
    }),
    (error) =>
      error.code === "CONFLICT" &&
      error.detail.expectedVersion === editorTwo.version &&
      error.detail.currentVersion === winningSave.version,
  );
  const winningSnapshot = await handlers["modelsConfig.get"]();
  assert.deepEqual(winningSnapshot.config, v084Config);
  assert.equal(winningSnapshot.version, winningSave.version);

  const models = await handlers["models.list"]({ cwd: root });
  assert.equal(models.catalog.source, "offline");
  const refreshedModels = await handlers["models.refresh"]({ cwd: root, requestId: "offline-test" });
  assert.equal(refreshedModels.catalog.source, "offline");
  assert.deepEqual(await handlers["models.refreshCancel"]({ requestId: "offline-test" }), {
    ok: true,
    cancelled: false,
  });

  const invalidModelTest = await handlers["modelsConfig.test"]({});
  assert.deepEqual(invalidModelTest, { ok: false, error: "providerName is required" });

  const oauthProviders = await handlers["auth.providers"]();
  assert.equal(Array.isArray(oauthProviders.providers), true);
  const allProviders = await handlers["auth.allProviders"]();
  assert.equal(Array.isArray(allProviders.providers), true);

  assert.deepEqual(await handlers["auth.setApiKey"]({ provider: "openai", key: "secret" }), {
    ok: true,
    synchronized: true,
  });
  const preferences = await handlers["models.preferences.get"]({ cwd: root });
  assert.equal(Array.isArray(preferences.models), true);
  assert.equal(preferences.enabledModels, null);
  await assert.rejects(
    handlers["models.preferences.set"]({ cwd: root, enabledModels: [] }),
    (error) => error.code === "BAD_REQUEST",
  );
  const selectedModel = preferences.models.find((model) => model.provider === "openai");
  assert.ok(selectedModel, "setting an OpenAI credential should expose OpenAI models");
  const selectedReference = `${selectedModel.provider}/${selectedModel.id}`;
  const updatedPreferences = await handlers["models.preferences.set"]({
    cwd: root,
    enabledModels: [`${selectedReference}:high`, selectedReference],
  });
  assert.deepEqual(updatedPreferences.enabledModels, [selectedReference]);
  const filteredModels = await handlers["models.list"]({ cwd: root });
  assert.deepEqual(
    filteredModels.models.map((model) => `${model.provider}/${model.id}`),
    [selectedReference],
  );
  const resetPreferences = await handlers["models.preferences.set"]({ cwd: root, enabledModels: null });
  assert.equal(resetPreferences.enabledModels, null);
  await assert.rejects(
    handlers["auth.setApiKey"]({ provider: "amazon-bedrock", key: "not-a-bearer-token" }),
    (error) => error.code === "BAD_REQUEST" && /interactive, multi-field/.test(error.message),
  );
  assert.deepEqual(await handlers["auth.deleteApiKey"]({ provider: "openai" }), {
    ok: true,
    synchronized: true,
  });
  assert.deepEqual(await handlers["auth.logout"]({ provider: "openai" }), { ok: true, synchronized: true });
  assert.deepEqual(await handlers["auth.loginCancel"]({ provider: "handler-test" }), { ok: true });
  await assert.rejects(
    handlers["auth.loginSubmit"]({ provider: "one", token: "two-token", code: "code" }),
    (error) => error.code === "NOT_FOUND",
  );

  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  writeFileSync(modelsPath, "{broken json", "utf8");
  assert.throws(
    () => handlers["modelsConfig.get"](),
    (error) => error.code === "PARSE_ERROR",
  );
  assert.equal(readFileSync(modelsPath, "utf8"), "{broken json");
});

test("sessions.get returns the contract shape without rescanning known session paths", async (t) => {
  const sessionDirectory = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "contract-fixture");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionId = "contract-session";
  const sessionPath = path.join(sessionDirectory, `2026-08-06T00-00-00-000Z_${sessionId}.jsonl`);
  const entries = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-06T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "user-one",
      parentId: null,
      timestamp: "2026-08-06T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1_786_060_801_000 },
    },
    {
      type: "message",
      id: "assistant-one",
      parentId: "user-one",
      timestamp: "2026-08-06T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_802_000,
      },
    },
    {
      type: "message",
      id: "user-two",
      parentId: "assistant-one",
      timestamp: "2026-08-06T00:00:03.000Z",
      message: { role: "user", content: "second", timestamp: 1_786_060_803_000 },
    },
    {
      type: "message",
      id: "assistant-two",
      parentId: "user-two",
      timestamp: "2026-08-06T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1_786_060_804_000,
      },
    },
  ];
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const { handlers } = await captureHandlers();
  const listed = await handlers["sessions.list"]();
  assert.equal(
    listed.sessions.some((session) => session.id === sessionId),
    true,
  );
  const filtered = await handlers["sessions.list"]({ cwd: path.join(root, ".") });
  assert.equal(
    filtered.sessions.some((session) => session.id === sessionId),
    true,
  );
  const excluded = await handlers["sessions.list"]({ cwd: isolatedAgentDirectory });
  assert.equal(
    excluded.sessions.some((session) => session.id === sessionId),
    false,
  );
  await assert.rejects(handlers["sessions.list"]({ cwd: "relative/project" }), (error) => error.code === "BAD_REQUEST");

  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => {
    throw new Error("global scan must not run");
  };
  t.after(() => {
    SessionManager.listAll = originalListAll;
  });

  const detail = await handlers["sessions.get"]({ id: sessionId });
  assert.deepEqual(Object.keys(detail).sort(), ["context", "filePath", "info", "leafId", "sessionId", "tree"]);
  assert.equal(detail.sessionId, sessionId);
  assert.equal(detail.filePath, sessionPath);
  assert.equal(detail.info.id, sessionId);
  assert.equal(detail.info.messageCount, 4);
  assert.equal(detail.info.firstMessage, "hello");
  assert.deepEqual(detail.context.entryIds, ["user-one", "assistant-one", "user-two", "assistant-two"]);
  assert.equal(detail.context.messages.length, 4);

  const paged = await handlers["sessions.get"]({ id: sessionId, historyWindow: { maxTurns: 1, maxBytes: 64 * 1024 } });
  assert.deepEqual(paged.context.entryIds, ["user-two", "assistant-two"]);
  assert.equal(paged.context.truncatedBefore, true);
  const older = await handlers["sessions.contextPage"]({ id: sessionId, cursor: paged.context.previousCursor });
  assert.deepEqual(older.context.entryIds, ["user-one", "assistant-one"]);
  const cursorPayload = JSON.parse(Buffer.from(paged.context.previousCursor, "base64url").toString("utf8"));
  const staleCursor = Buffer.from(
    JSON.stringify({ ...cursorPayload, historyRevision: "stale-revision" }),
    "utf8",
  ).toString("base64url");
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: staleCursor }),
    (error) => error.code === "STALE_CURSOR",
  );
  await assert.rejects(
    handlers["sessions.contextPage"]({ id: sessionId, cursor: "invalid" }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.deepEqual(await handlers["sessions.entryContent"]({ id: sessionId, entryId: "assistant-two" }), {
    content: { type: "text", text: "second answer" },
    deferredContent: {
      entryId: "assistant-two",
      blockIndex: 0,
      originalBytes: Buffer.byteLength(JSON.stringify({ type: "text", text: "second answer" }), "utf8"),
      contentType: "text",
    },
  });
  await assert.rejects(
    handlers["sessions.entryContent"]({ id: sessionId, entryId: "another-session-entry", blockIndex: 0 }),
    (error) => error.code === "NOT_FOUND",
  );
});
