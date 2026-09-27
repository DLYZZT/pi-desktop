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
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { AgentSessionWrapper, SessionPromptPolicy, createDesktopPromptExtension } = await importTestBundle(
  "pi-session-prompt-policy",
  {
    packages: "external",
    stdin: {
      contents:
        'export { AgentSessionWrapper } from "./rpc-manager.ts"; export { SessionPromptPolicy, createDesktopPromptExtension } from "./session-prompt-policy.ts";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  },
);

async function createFixture(t, initialTools, additionalExtensions = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-prompt-"));
  const policy = new SessionPromptPolicy(initialTools.length === 0);
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [...additionalExtensions, createDesktopPromptExtension(policy)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    model,
  });
  // Desktop narrows the active set after construction so tools can be enabled later.
  session.setActiveToolsByName(initialTools);
  const wrapper = new AgentSessionWrapper(session, initialTools, () => undefined, policy);
  wrapper.setToolchainSummary(7, ["Use the resolved toolchain"]);
  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
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
  await session.bindExtensions({ mode: "rpc" });
  t.after(async () => {
    await wrapper.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { session, wrapper, policy, requests };
}

function requestPrompt(context) {
  return context.systemPrompt ?? ai.getCurrentSystemPrompt?.(context.messages) ?? "";
}

function requestToolNames(context) {
  return (context.tools ?? ai.getCurrentTools?.(context.messages) ?? []).map((tool) => tool.name);
}

test("Desktop toolchain prompt reaches real SDK requests after user extensions and updates once", async (t) => {
  const extension = {
    name: "user-prompt",
    factory(pi) {
      pi.on("before_agent_start", () => ({ systemPrompt: "User extension prompt" }));
    },
  };
  const { session, wrapper, requests } = await createFixture(t, ["read"], [extension]);
  await session.prompt("first", { source: "rpc" });
  const first = requestPrompt(requests.at(-1));
  assert.match(first, /^User extension prompt/);
  assert.match(first, /<pi-desktop-toolchain revision="7">/);
  assert.equal(first.match(/<pi-desktop-toolchain revision=/g)?.length, 1);
  assert.deepEqual(requestToolNames(requests.at(-1)), ["read"]);

  wrapper.setToolchainSummary(8, ["Use the updated toolchain"]);
  await session.prompt("second", { source: "rpc" });
  const second = requestPrompt(requests.at(-1));
  assert.match(second, /revision="8"/);
  assert.doesNotMatch(second, /revision="7"/);
  assert.equal(second.match(/<pi-desktop-toolchain revision=/g)?.length, 1);

  await wrapper.send({ type: "reload" });
  await session.prompt("after reload", { source: "rpc" });
  const reloaded = requestPrompt(requests.at(-1));
  assert.match(reloaded, /revision="8"/);
  assert.equal(reloaded.match(/<pi-desktop-toolchain revision=/g)?.length, 1);

  const firstUser = session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(firstUser);
  const navigation = await session.navigateTree(firstUser.id, { summarize: false });
  assert.equal(navigation.cancelled, false);
  await session.prompt("after branch navigation", { source: "rpc" });
  const branched = requestPrompt(requests.at(-1));
  assert.match(branched, /revision="8"/);
  assert.equal(branched.match(/<pi-desktop-toolchain revision=/g)?.length, 1);
});

test("zero-tool prompt remains empty through tool changes without mutating AgentState", async (t) => {
  const { session, wrapper, requests } = await createFixture(t, []);
  await session.prompt("without tools", { source: "rpc" });
  assert.equal(requestPrompt(requests.at(-1)), "");
  assert.deepEqual(requestToolNames(requests.at(-1)), []);

  await wrapper.send({ type: "set_tools", toolNames: ["read"] });
  await session.prompt("with read", { source: "rpc" });
  assert.match(requestPrompt(requests.at(-1)), /<pi-desktop-toolchain revision="7">/);
  assert.deepEqual(requestToolNames(requests.at(-1)), ["read"]);

  await wrapper.send({ type: "set_tools", toolNames: [] });
  await session.prompt("without tools again", { source: "rpc" });
  assert.equal(requestPrompt(requests.at(-1)), "");
  assert.deepEqual(requestToolNames(requests.at(-1)), []);

  await wrapper.runExternalTurn({ runId: "im-prompt-fixture", message: "IM message", channel: "telegram" });
  assert.equal(requestPrompt(requests.at(-1)), "");
  assert.deepEqual(requestToolNames(requests.at(-1)), []);
});

test("late extension tool registration cannot reactivate a no-tools session", async (t) => {
  let active = [];
  const inner = {
    sessionId: "late-tool-fixture",
    sessionManager: { getHeader: () => ({ cwd: "/fixture" }) },
    agent: { state: { messages: [] } },
    extensionRunner: {},
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names) => {
      active = [...names];
    },
    async bindExtensions() {
      // The SDK activates tools that become available during extension setup.
      active = ["mcp_fixture_tool"];
    },
  };
  const wrapper = new AgentSessionWrapper(inner, [], () => undefined, new SessionPromptPolicy(true));
  t.after(() => wrapper.destroy());
  await wrapper.ensureExtensionsBound();
  assert.deepEqual(active, [], "no-tools selection must survive extension registration");
});

test("tool queries wait for late extension registration and return the enforced no-tools state", async (t) => {
  const registered = createDeferred();
  const release = createDeferred();
  let active = [];
  const inner = {
    sessionId: "late-tool-query",
    sessionManager: { getHeader: () => ({ cwd: "/fixture" }) },
    agent: { state: { messages: [] } },
    extensionRunner: {},
    getAllTools: () => [{ name: "mcp_fixture_tool", description: "fixture" }],
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names) => {
      active = [...names];
    },
    async bindExtensions() {
      active = ["mcp_fixture_tool"];
      registered.resolve();
      await release.promise;
    },
  };
  const wrapper = new AgentSessionWrapper(inner, [], () => undefined, new SessionPromptPolicy(true));
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding({ forceEmptySystemPrompt: true });
  await registered.promise;
  let settled = false;
  const query = wrapper.send({ type: "get_tools" }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a partial extension registry is not a stable tool snapshot");
  release.resolve();
  assert.deepEqual(await query, [{ name: "mcp_fixture_tool", description: "fixture", active: false }]);
  assert.deepEqual(active, []);
});

test("tool queries clear tools reactivated after extension binding", async (t) => {
  const { session, wrapper } = await createFixture(t, []);
  session.setActiveToolsByName(["read"]);
  assert.deepEqual(session.getActiveToolNames(), ["read"]);
  const tools = await wrapper.send({ type: "get_tools" });
  assert.equal(tools.find((tool) => tool.name === "read")?.active, false);
  assert.deepEqual(session.getActiveToolNames(), []);
});
