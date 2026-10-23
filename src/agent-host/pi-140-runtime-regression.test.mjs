import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as ai from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { importTestBundle } from "#test-bundle";

const userData = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-userdata-"));
process.env.PI_DESKTOP_USER_DATA = userData;
test.after(() => rmSync(userData, { recursive: true, force: true }));

const {
  AgentSessionWrapper,
  SessionPromptPolicy,
  SessionToolPolicy,
  createDesktopPromptExtension,
  setAgentSessionSource,
} = await importTestBundle("pi-140-runtime-regression", {
  packages: "external",
  stdin: {
    contents:
      'export { AgentSessionWrapper } from "./rpc-manager.ts"; export { SessionPromptPolicy, createDesktopPromptExtension } from "./session-prompt-policy.ts"; export { SessionToolPolicy } from "./session-tool-policy.ts"; export { setAgentSessionSource } from "./session-source.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

function offlineStream(requests) {
  return (requestModel, context) => {
    requests.push(context);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "offline answer" }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = ai.createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
}

test("branch navigation reapplies the Desktop tool selection over the SDK-restored loadout", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-tree-"));
  const policy = new SessionPromptPolicy(false);
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createDesktopPromptExtension(policy)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    model,
  });
  const requests = [];
  session.agent.streamFunction = offlineStream(requests);
  await session.bindExtensions({ mode: "rpc" });

  // An earlier part of the branch ran with a wider loadout than the current Desktop choice.
  session.setActiveToolsByName(["read", "bash"]);
  await session.prompt("first", { source: "rpc" });
  const wrapper = new AgentSessionWrapper(session, ["read"], () => undefined, policy);
  t.after(async () => {
    await wrapper.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  session.setActiveToolsByName(["read"]);
  await session.prompt("second", { source: "rpc" });
  assert.deepEqual(session.getActiveToolNames(), ["read"]);

  const firstUser = session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  const navigation = await wrapper.send({ type: "navigate_tree", targetId: firstUser.id });
  assert.equal(navigation.cancelled, false);
  assert.deepEqual(session.getActiveToolNames(), ["read"]);
});

function extensionTool(name, defaultActive) {
  return {
    name: `fixture-${name}`,
    factory(pi) {
      pi.registerTool({
        name,
        label: name,
        description: `Fixture ${name}`,
        parameters: Type.Object({}),
        ...(defaultActive === false ? { defaultActive } : {}),
        async execute() {
          return { content: [{ type: "text", text: name }], details: undefined };
        },
      });
    },
  };
}

async function openSession(directory, sessionManager, extensionFactories) {
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  // Desktop never passes `tools`, so the SDK restores the recorded loadout like a CLI resume.
  const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
  session.agent.streamFunction = offlineStream([]);
  await session.bindExtensions({ mode: "rpc" });
  return session;
}

test("a CLI session without a Desktop selection keeps the SDK-restored loadout as its grant baseline", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-cli-"));
  const sessionDir = path.join(directory, "sessions");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const cli = await openSession(directory, SessionManager.create(directory, sessionDir), []);
  cli.setActiveToolsByName(["read"]);
  await cli.prompt("recorded by the CLI", { source: "rpc" });
  const sessionFile = cli.sessionFile;
  cli.dispose();
  assert.ok(sessionFile);

  // Extensions installed after the branch recorded its loadout.
  const manager = SessionManager.open(sessionFile, sessionDir);
  setAgentSessionSource(manager, "local");
  const session = await openSession(directory, manager, [
    extensionTool("late_tool"),
    extensionTool("late_off_tool", false),
  ]);
  t.after(() => session.dispose());
  const policy = new SessionToolPolicy(manager, undefined, undefined, undefined, "darwin");
  policy.bind(session);

  const active = session.getActiveToolNames();
  assert.ok(active.includes("read"));
  assert.ok(
    active.includes("late_tool"),
    "extension tools the branch never mentioned follow their registration default",
  );
  assert.ok(!active.includes("late_off_tool"));
  assert.ok(!active.includes("bash"), "built-in tools follow the recorded loadout, not defaultTools");
  assert.equal(policy.isAllowed("read"), true);
  assert.equal(policy.isAllowed("late_tool"), true);
  assert.equal(policy.isAllowed("late_off_tool"), false);
  assert.equal(policy.isAllowed("bash"), false);

  // Activating a coding tool later never exceeds the initial loadout without a Desktop selection.
  session.setActiveToolsByName([...active, "bash"]);
  assert.equal(policy.isAllowed("bash"), false);
});

test("manual compaction through Desktop sends no reserve-derived output cap and keeps instructions", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-compact-"));
  const policy = new SessionPromptPolicy(false);
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    // reserveTokens only decides when automatic compaction starts in Pi 1.4.0.
    settingsManager: SettingsManager.inMemory({
      defaultTools: [],
      cacheWarming: "off",
      compaction: { reserveTokens: 1000, keepRecentTokens: 1 },
    }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createDesktopPromptExtension(policy)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    model,
  });
  const calls = [];
  const respond = offlineStream([]);
  session.agent.streamFunction = (requestModel, context, options) => {
    calls.push({ context, options });
    return respond(requestModel, context);
  };
  await session.bindExtensions({ mode: "rpc" });
  const wrapper = new AgentSessionWrapper(session, ["read"], () => undefined, policy);
  t.after(async () => {
    await wrapper.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const text of ["first ".repeat(200), "second ".repeat(200), "third"])
    await session.prompt(text, { source: "rpc" });
  const chatCalls = calls.length;

  const result = await wrapper.send({ type: "compact", customInstructions: "FOCUS_MARKER" });
  assert.ok(result?.summary);
  const summaries = calls.slice(chatCalls);
  assert.ok(summaries.length >= 1);
  for (const { context, options } of summaries) {
    assert.equal(Object.hasOwn(options ?? {}, "maxTokens"), false, "1.2.0 sent floor(0.8 * reserveTokens)");
    assert.match(JSON.stringify(context.messages), /FOCUS_MARKER/);
  }
});

test("branch navigation drops restored tools that register later outside the Desktop selection", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-pending-"));
  const sessionDir = path.join(directory, "sessions");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lateTool = extensionTool("late_off_tool", false);

  // The older part of the branch explicitly enabled a defaultActive:false extension tool.
  const recorder = await openSession(directory, SessionManager.create(directory, sessionDir), [lateTool]);
  recorder.setActiveToolsByName(["read", "late_off_tool"]);
  await recorder.prompt("first", { source: "rpc" });
  recorder.setActiveToolsByName(["read"]);
  await recorder.prompt("second", { source: "rpc" });
  const sessionFile = recorder.sessionFile;
  recorder.dispose();

  // Reopen before that extension registers its tool, as with an MCP server that is still connecting.
  let registerLater;
  const session = await openSession(directory, SessionManager.open(sessionFile, sessionDir), [
    {
      name: "fixture-late-registration",
      factory(pi) {
        registerLater = () => lateTool.factory(pi);
      },
    },
  ]);
  const policy = new SessionPromptPolicy(false);
  const wrapper = new AgentSessionWrapper(session, ["read"], () => undefined, policy);
  t.after(() => wrapper.dispose());
  session.setActiveToolsByName(["read"]);

  const firstUser = session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal((await wrapper.send({ type: "navigate_tree", targetId: firstUser.id })).cancelled, false);
  assert.deepEqual(session.getActiveToolNames(), ["read"]);
  registerLater();
  assert.ok(session.getAllTools().some((tool) => tool.name === "late_off_tool"));
  assert.deepEqual(session.getActiveToolNames(), ["read"], "a restored pending name must not activate later");
});

async function recordLateTool(directory, sessionDir, loadouts) {
  const lateTool = extensionTool("late_off_tool", false);
  const recorder = await openSession(directory, SessionManager.create(directory, sessionDir), [lateTool]);
  for (const names of loadouts) {
    recorder.setActiveToolsByName(names);
    await recorder.prompt(`loadout ${names.join(",")}`, { source: "rpc" });
  }
  const sessionFile = recorder.sessionFile;
  recorder.dispose();
  let registerLater;
  const manager = SessionManager.open(sessionFile, sessionDir);
  setAgentSessionSource(manager, "local");
  const session = await openSession(directory, manager, [
    {
      name: "fixture-late-registration",
      factory(pi) {
        registerLater = () => lateTool.factory(pi);
      },
    },
  ]);
  return { manager, session, registerLater: () => registerLater() };
}

test("opening and reloading with a Desktop selection drop recorded tools that register later", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-open-pending-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionDir = path.join(directory, "sessions");

  for (const reload of [false, true]) {
    const { manager, session, registerLater } = await recordLateTool(directory, sessionDir, [
      ["read", "late_off_tool"],
    ]);
    const policy = new SessionToolPolicy(manager, ["read"], undefined, undefined, "darwin");
    policy.bind(session);
    // Production construction: narrow the SDK restore, then let the wrapper sync Desktop tools.
    session.setActiveToolsByName(["read"]);
    const wrapper = new AgentSessionWrapper(session, ["read"], () => undefined, undefined, undefined, policy);
    t.after(() => wrapper.dispose());
    wrapper.syncDesktopToolActivation();
    if (reload) await wrapper.send({ type: "reload" });
    registerLater();
    const tool = (await wrapper.send({ type: "get_tools" })).find((entry) => entry.name === "late_off_tool");
    assert.ok(tool, `registered (reload: ${reload})`);
    assert.equal(tool.active, false, `a recorded pending name must not activate later (reload: ${reload})`);
    assert.equal(policy.isAllowed("late_off_tool"), false);
  }
});

test("the public no-tools guard hides a recorded tool that registers after navigation", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-140-empty-pending-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { session, registerLater } = await recordLateTool(directory, path.join(directory, "sessions"), [
    ["late_off_tool"],
    [],
  ]);
  const wrapper = new AgentSessionWrapper(session, [], () => undefined, new SessionPromptPolicy(true));
  t.after(() => wrapper.dispose());
  session.setActiveToolsByName([]);
  const firstUser = session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal((await wrapper.send({ type: "navigate_tree", targetId: firstUser.id })).cancelled, false);
  registerLater();
  // The empty active set cannot clear SDK pending names; get_tools and prompts reapply no-tools first.
  assert.ok((await wrapper.send({ type: "get_tools" })).every((tool) => !tool.active));
  assert.deepEqual(session.getActiveToolNames(), []);
});
