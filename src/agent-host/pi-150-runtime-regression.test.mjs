import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

function assistant(text, model = { api: "openai-completions", provider: "fixture-oauth", id: "fixture" }) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function directory(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-150-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function oauthSession(t, root, extensionPaths = []) {
  let credential = {
    type: "oauth",
    access: "FIXTURE_OAUTH",
    refresh: "FIXTURE_REFRESH",
    expires: Date.now() + 3600000,
  };
  const provider = "fixture-oauth";
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: {
      read: async (id) => (id === provider ? credential : undefined),
      list: async () => [{ providerId: provider, type: "oauth" }],
      modify: async (_id, update) => (credential = await update(credential)),
      delete: async () => {
        credential = undefined;
      },
    },
  });
  const model = {
    id: "fixture",
    name: "Fixture",
    provider,
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const requests = [],
    overrides = [];
  runtime.registerProvider(provider, {
    name: "Fixture OAuth",
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: "UNUSED_FIXTURE_ENV",
    oauth: {
      name: "Fixture subscription",
      login: async () => credential,
      refreshToken: async (value) => value,
      getApiKey: (value) => value.access,
    },
    models: [model],
    streamSimple: (requestModel, context, options) => {
      requests.push({ context, options });
      const stream = createAssistantMessageEventStream();
      stream.end(assistant("fixture summary", requestModel));
      return stream;
    },
  });
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (...args) => {
    overrides.push(args[1]?.apiKey);
    return getAuth(...args);
  };
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1024 },
    }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: extensionPaths,
    },
  });
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel(provider, "fixture"),
    thinkingLevel: "high",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  return { session, manager, requests, overrides, services };
}

for (const kind of ["branch", "compaction"]) {
  test(`SDK ${kind} uses stored OAuth rather than an explicit API-key override`, async (t) => {
    const root = directory(t);
    const { session, manager, requests, overrides } = await oauthSession(t, root);
    const target = manager.appendMessage({ role: "user", content: "first branch", timestamp: 1 });
    manager.appendMessage(assistant("first answer"));
    const hidden = manager.appendMessage({ role: "user", content: "HIDDEN_ORIGINAL", timestamp: 2 });
    manager.appendMessage(assistant("branch work ".repeat(100)));
    manager.appendContextEdit(hidden, { content: [{ type: "text", text: "VISIBLE_REPLACEMENT" }] });
    manager.appendMessage({ role: "user", content: "latest question", timestamp: 3 });
    manager.appendMessage(assistant("latest answer"));
    if (kind === "branch") {
      const result = await session.navigateTree(target, { summarize: true });
      assert.match(result.summaryEntry.summary, /fixture summary/);
      assert.equal(requests[0].options.reasoning, "high");
      assert.doesNotMatch(JSON.stringify(requests[0].context), /HIDDEN_ORIGINAL/);
      assert.match(JSON.stringify(requests[0].context), /VISIBLE_REPLACEMENT/);
    } else {
      await session.compact();
    }
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.options.apiKey === "FIXTURE_OAUTH"));
    assert.ok(overrides.length > 0);
    assert.ok(overrides.every((value) => value === undefined));
  });
}

test("write failure leaves memory and the restored Desktop session on the same parent", (t) => {
  const root = directory(t);
  const session = SessionManager.create(root, root);
  const first = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const file = session.getSessionFile(),
    backup = file + ".fixture-backup";
  const original = readFileSync(file);
  renameSync(file, backup);
  mkdirSync(file);
  try {
    assert.throws(() => session.appendMessage(assistant("failed write")));
    assert.equal(session.getLeafId(), first);
    assert.deepEqual(
      session.getEntries().map((entry) => entry.id),
      [first],
    );
  } finally {
    rmSync(file, { recursive: true });
    renameSync(backup, file);
  }
  assert.deepEqual(readFileSync(file), original);
  const second = session.appendMessage(assistant("persisted answer"));
  assert.equal(session.getEntry(second).parentId, first);
  assert.deepEqual(
    SessionManager.open(file)
      .getBranch()
      .map((entry) => entry.id),
    [first, second],
  );
});

test("legacy filesystem extensions keep TypeBox imports and reordering active tools keeps their prompt order", async (t) => {
  const root = directory(t),
    extension = path.join(root, "legacy.ts");
  writeFileSync(
    extension,
    `import { Type, StringEnum } from "@earendil-works/pi-ai";
export default function(pi) { pi.registerTool({name:"legacy_fixture",label:"fixture",description:"fixture",parameters:Type.Object({choice:StringEnum(["a","b"])}),async execute(_id,input){return {content:[{type:"text",text:input.choice}]};}}); }`,
  );
  const { session, services } = await oauthSession(t, root, [extension]);
  assert.deepEqual(
    services.diagnostics.filter((entry) => entry.type === "error"),
    [],
  );
  assert.ok(session.getAllTools().some((tool) => tool.name === "legacy_fixture"));
  session.setActiveToolsByName(["read", "legacy_fixture"]);
  const before = session.getActiveToolNames();
  session.setActiveToolsByName([...before].reverse());
  assert.deepEqual(session.getActiveToolNames(), before);
});
