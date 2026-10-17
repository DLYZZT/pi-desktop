import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SettingsManager,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createDeferred } from "#test-timing";
import { importTestBundle } from "#test-bundle";
const {
  AgentSessionWrapper,
  SessionToolPolicy,
  DesktopSessionToolStore,
  applySessionToolCommand,
  createDesktopSessionTools,
  browserAgentRuntime,
  setAgentSessionSource,
} = await importTestBundle("powershell-review", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {AgentSessionWrapper} from './rpc-manager.ts';
    export {SessionToolPolicy} from './session-tool-policy.ts';
    export {DesktopSessionToolStore} from './session-tool-store.ts';
    export {applySessionToolCommand} from './session-tool-settings.ts';
    export {createDesktopSessionTools} from './desktop-session-tools.ts';
    export {browserAgentRuntime} from './browser-agent-runtime.ts';
    export {setAgentSessionSource} from './session-source.ts';`,
  },
});

function directory(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-m2-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const type of ["set_orchestration_tools", "set_execution_tools"])
  test(`${type} cannot turn an SDK-only PowerShell activation into a persisted grant`, (t) => {
    const root = directory(t),
      file = path.join(root, "tools.json"),
      store = new DesktopSessionToolStore(file, "win32");
    const manager = {};
    let active = ["read"];
    const definitions = ["read", "powershell", "codemode", "tool_search", "extension"].map((name) => ({
      name,
      description: name,
    }));
    const session = {
      getAllTools: () => definitions,
      getToolDefinition: (name) => definitions.find((tool) => tool.name === name),
      getActiveToolNames: () => active,
      setActiveToolsByName: (names) => {
        active = names;
      },
    };
    const policy = new SessionToolPolicy(manager, undefined, undefined, undefined, "win32");
    setAgentSessionSource(manager, "local");
    policy.bind(session);
    active = ["read", "powershell", "codemode"];
    assert.equal(policy.isAllowed("powershell"), false);
    applySessionToolCommand(
      {
        sessionId: "session",
        session,
        policy,
        preferences: store,
        apply: (names) => {
          active = names;
          policy.setRequested(names);
        },
      },
      { type, toolNames: type === "set_orchestration_tools" ? ["tool_search"] : ["extension"] },
    );
    assert.ok(!store.get("session").includes("powershell"));
    assert.ok(!new DesktopSessionToolStore(file, "win32").get("session").includes("powershell"));
    assert.equal(policy.isAllowed("powershell"), false);
  });

test("PowerShell rechecks its grant after a pending browser approval before spawning", async (t) => {
  const root = directory(t),
    entered = createDeferred(),
    approval = createDeferred();
  t.after(() => approval.resolve());
  t.mock.method(browserAgentRuntime, "guardBash", async () => {
    entered.resolve();
    await approval.promise;
  });
  const context = {
    inventoryRevision: 1,
    summary: [],
    commands: {
      "shell.powershell": {
        executable: path.join(root, "must-not-spawn.exe"),
        argvPrefix: [],
        capability: "shell.powershell",
        envPatch: {},
      },
    },
    nativeEnv: {},
    shellEnv: {},
  };
  const runtime = {
    createExecutionContext: async () => context,
    requireFromContext: (_name, ctx) => ctx.commands["shell.powershell"],
  };
  const tools = await createDesktopSessionTools(
    root,
    { getSessionId: () => "approval" },
    { isProjectTrusted: () => true, getShellCommandPrefix: () => undefined },
    { tool: () => ({ name: "history", execute: async () => ({ content: [] }) }) },
    { runtime, platform: "win32" },
  );
  let allowed = true;
  tools.attach({ setToolchainSummary() {} }, { setAvailability() {}, isAllowed: () => allowed });
  const powershell = tools.customTools.find((tool) => tool.name === "powershell");
  const pending = powershell.execute("call", { command: "Write-Output ok" });
  await entered.promise;
  allowed = false;
  approval.resolve();
  await assert.rejects(pending, /TOOL_PERMISSION_DENIED/);
});

async function sdkSession(t, factory, tools = []) {
  const root = directory(t),
    settings = SettingsManager.create(root, root);
  const manager = SessionManager.inMemory(root),
    policy = new SessionToolPolicy(manager, tools);
  setAgentSessionSource(manager, "local");
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [policy.extension(), ...(factory ? [{ name: "fixture", factory }] : [])],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "OFFLINE_FIXTURE");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    tools,
  });
  policy.bind(session);
  const wrapper = new AgentSessionWrapper(session, tools, () => {}, undefined, undefined, policy);
  wrapper.start();
  t.after(async () => wrapper.dispose({ abort: true }));
  await wrapper.send({ type: "get_tools" });
  return { root, session, wrapper, settings, policy };
}

test("reload refreshes the toolchain from newly loaded settings before extension startup", async (t) => {
  let observed, refreshed;
  const starts = [];
  const f = await sdkSession(t, (pi) => {
    pi.on("session_start", (event) => {
      starts.push(event.reason);
      if (event.reason === "reload") observed = refreshed;
    });
  });
  const { root, wrapper, settings } = f;
  wrapper.refreshToolchain = async () => {
    refreshed = settings.getShellCommandPrefix();
  };
  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ shellCommandPrefix: "CURRENT_CONFIG", cacheWarming: "off" }),
  );
  await wrapper.send({ type: "reload" });
  assert.equal(refreshed, "CURRENT_CONFIG");
  assert.equal(observed, "CURRENT_CONFIG");
  assert.deepEqual(starts, ["startup", "reload"], "reload must not dispatch a second startup event");
});

test("resource reload waits for an SDK extension run outside the Desktop turn queue", async (t) => {
  const entered = createDeferred(),
    release = createDeferred();
  t.after(() => release.resolve());
  const f = await sdkSession(t, undefined, ["read"]);
  let refreshes = 0;
  f.wrapper.refreshToolchain = async () => {
    refreshes++;
  };
  f.session.agent.streamFunction = async (model) => {
    entered.resolve();
    await release.promise;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    globalThis.queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  const run = f.session.sendCustomMessage(
    { customType: "fixture", content: "continue", display: false },
    { triggerTurn: true },
  );
  await entered.promise;
  let ended = false;
  const reload = f.wrapper.send({ type: "reload" }).then(() => {
    ended = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 0);
  assert.equal(ended, false);
  assert.equal(f.policy.isAllowed("read"), true, "queued reload must not revoke the still-running turn's tools");
  release.resolve();
  await run;
  await reload;
  assert.equal(refreshes, 1);
});

test("extension-command reload uses the same toolchain refresh boundary", { timeout: 5000 }, async (t) => {
  const finished = createDeferred();
  const f = await sdkSession(t, (pi) =>
    pi.registerCommand("refresh-tools", {
      description: "fixture",
      handler: async (_args, ctx) => {
        try {
          await ctx.reload();
          finished.resolve();
        } catch (error) {
          finished.reject(error);
        }
      },
    }),
  );
  let prefix;
  f.wrapper.refreshToolchain = async () => {
    prefix = f.settings.getShellCommandPrefix();
  };
  writeFileSync(
    path.join(f.root, "settings.json"),
    JSON.stringify({ shellCommandPrefix: "EXTENSION_RELOADED", cacheWarming: "off" }),
  );
  await f.wrapper.send({ type: "prompt", message: "/refresh-tools" });
  await finished.promise;
  assert.equal(prefix, "EXTENSION_RELOADED");
});

test("a failed reload blocks implicit rebind and tool execution until an explicit successful retry", async (t) => {
  let starts = 0;
  const f = await sdkSession(
    t,
    (pi) =>
      pi.on("session_start", () => {
        starts++;
      }),
    ["read"],
  );
  const { policy, wrapper } = f;
  f.session.setActiveToolsByName(["read"]);
  assert.equal(policy.isAllowed("read"), true);
  let resolves = 0;
  wrapper.refreshToolchain = async () => {
    resolves++;
    throw new Error("TOOLCHAIN_REFRESH_FAILED");
  };
  await assert.rejects(wrapper.send({ type: "reload" }), /TOOLCHAIN_REFRESH_FAILED/);
  const failedStarts = starts;
  assert.equal(policy.isAllowed("read"), false);
  await assert.rejects(wrapper.send({ type: "get_tools" }), /TOOLCHAIN_REFRESH_FAILED/);
  assert.equal(starts, failedStarts);
  assert.equal(resolves, 1);
  wrapper.refreshToolchain = async () => {
    resolves++;
  };
  await wrapper.send({ type: "reload" });
  assert.equal(policy.isAllowed("read"), true);
  assert.equal(resolves, 2);
});

test("tool queries wait for reload publication and cannot bind or execute against a partial snapshot", async (t) => {
  const entered = createDeferred(),
    release = createDeferred();
  t.after(() => release.resolve());
  let starts = 0;
  const f = await sdkSession(
    t,
    (pi) =>
      pi.on("session_start", () => {
        starts++;
      }),
    ["read"],
  );
  f.wrapper.refreshToolchain = async () => {
    entered.resolve();
    await release.promise;
  };
  const reload = f.wrapper.send({ type: "reload" });
  await entered.promise;
  assert.equal(f.policy.isAllowed("read"), false);
  let readDone = false;
  const read = f.wrapper.send({ type: "get_tools" }).then((tools) => {
    readDone = true;
    return tools;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readDone, false);
  assert.equal(starts, 1);
  release.resolve();
  await reload;
  await read;
  assert.equal(starts, 2);
  assert.equal(f.policy.isAllowed("read"), true);
});

test("automatic snapshots preserve an existing explicit Windows PowerShell grant", (t) => {
  const store = new DesktopSessionToolStore(path.join(directory(t), "tools.json"), "win32");
  store.set("approved", ["powershell", "read"]);
  store.setFromActive("approved", ["powershell", "read", "codemode"]);
  assert.ok(store.get("approved").includes("powershell"));
  store.setFromActive("unknown", ["powershell", "read"]);
  assert.deepEqual(store.get("unknown"), ["read"]);
  assert.deepEqual(store.filterActiveSelection("approved", ["powershell", "read"], []), ["read"]);
});

test("a model recovery error does not invalidate a successfully rebuilt toolchain", async (t) => {
  const f = await sdkSession(t, undefined, ["read"]);
  t.mock.method(f.wrapper.modelSelection, "prepareConfigRecovery", () => true);
  t.mock.method(f.wrapper.modelSelection, "restoreAfterConfigRepair", async () => {
    throw new Error("Model authentication unavailable");
  });
  await assert.rejects(f.wrapper.send({ type: "reload" }), /Model authentication unavailable/);
  await f.wrapper.send({ type: "get_tools" });
  assert.equal(f.policy.isAllowed("read"), true);
});

test("a failed tool-definition rebuild retains both the previous availability and definitions", async (t) => {
  const root = directory(t);
  let context = {
    inventoryRevision: 1,
    summary: [],
    commands: { "shell.powershell": { executable: "old", argvPrefix: [] } },
    nativeEnv: {},
    shellEnv: {},
  };
  const settings = { isProjectTrusted: () => true, getShellCommandPrefix: () => undefined };
  const runtime = { createExecutionContext: async () => context, requireFromContext: () => {} };
  const tools = await createDesktopSessionTools(
    root,
    { getSessionId: () => "atomic" },
    settings,
    { tool: () => ({ name: "history", execute: async () => ({ content: [] }) }) },
    { runtime, platform: "win32" },
  );
  let available;
  const wrapper = { setToolchainSummary() {} };
  tools.attach(wrapper, {
    setAvailability: (check) => {
      available = check;
    },
    isAllowed: () => true,
  });
  assert.equal(available("powershell"), true);
  context = { ...context, inventoryRevision: 2, commands: {} };
  t.mock.method(settings, "getShellCommandPrefix", () => {
    throw new Error("rebuild failed");
  });
  await assert.rejects(wrapper.refreshToolchain(), /rebuild failed/);
  assert.equal(
    available("powershell"),
    true,
    "failed refresh must not publish a context mismatched with old definitions",
  );
});
