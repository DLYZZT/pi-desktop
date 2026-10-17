import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { codingToolAvailability, getToolNamesForPreset, getPresetFromTools } from "../shared/tool-presets.ts";
import { excludedPiTools } from "../shared/pi-tool-policy.ts";
const {
  DesktopSessionToolStore,
  ChannelConfigStore,
  SessionToolPolicy,
  setAgentSessionSource,
  createDesktopPowerShellTool,
} = await importTestBundle("powershell-permissions", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
export {DesktopSessionToolStore} from './session-tool-store.ts';
export {ChannelConfigStore} from './channels/config-store.ts';
export {SessionToolPolicy} from './session-tool-policy.ts';
export {setAgentSessionSource} from './session-source.ts';
export {createDesktopPowerShellTool} from './toolchain-powershell.ts';`,
  },
});

test("PowerShell record authorization is explicit, version 1 survives legacy save and non-Windows never enables it", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ps-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "tools.json");
  const original = JSON.stringify({
    version: 1,
    sessions: {
      one: { toolNames: ["powershell", "read"], executionToolNames: ["powershell"], updatedAt: "old" },
      two: { toolNames: ["bash", "write"], updatedAt: "old" },
    },
  });
  writeFileSync(file, original);
  const win = new DesktopSessionToolStore(file, "win32");
  assert.deepEqual(win.get("one"), ["read"]);
  assert.deepEqual(win.getExecution("one"), []);
  assert.equal(readFileSync(file, "utf8"), original);
  win.set("one", ["powershell", "read"]);
  let saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.sessions.one.policyRevision, 2);
  assert.deepEqual(new DesktopSessionToolStore(file, "win32").get("one"), ["powershell", "read"]);
  assert.deepEqual(new DesktopSessionToolStore(file, "darwin").get("one"), ["read"]);
  // A version-1 writer that predates M2 drops the new metadata and PowerShell but retains all other grants.
  delete saved.sessions.one.policyRevision;
  saved.sessions.one.toolNames = ["read"];
  writeFileSync(file, JSON.stringify(saved));
  const returned = new DesktopSessionToolStore(file, "win32");
  assert.deepEqual(returned.get("one"), ["read"]);
  assert.deepEqual(returned.get("two"), ["bash", "write"]);
  const channelsFile = path.join(root, "channels.json");
  const account = { id: "account", channel: "telegram", toolNames: ["powershell", "read"] };
  const binding = {
    id: "binding",
    accountId: "account",
    channel: "telegram",
    peerId: "one",
    peerKind: "dm",
    cwd: root,
    toolNames: ["powershell"],
  };
  writeFileSync(channelsFile, JSON.stringify({ version: 1, accounts: [account], bindings: [binding] }));
  const channels = new ChannelConfigStore(channelsFile, "win32");
  assert.deepEqual(channels.getAccount("account").toolNames, ["read"]);
  assert.deepEqual(channels.listBindings()[0].toolNames, []);
  channels.upsertAccount(account);
  channels.upsertBinding(binding);
  const reloaded = new ChannelConfigStore(channelsFile, "win32");
  assert.deepEqual(reloaded.getAccount("account").toolNames, ["powershell", "read"]);
  assert.deepEqual(reloaded.listBindings()[0].toolNames, ["powershell"]);
  assert.equal(JSON.parse(readFileSync(channelsFile, "utf8")).version, 1);
});

test("permission presets follow the configured available shell while declarations alone remain ungranted", () => {
  const choices = codingToolAvailability("win32", { "shell.powershell": {}, "search.rg": {}, "search.fd": {} });
  const full = getToolNamesForPreset("full", choices);
  assert.ok(full.includes("powershell"));
  assert.ok(!full.includes("bash"));
  assert.deepEqual(getToolNamesForPreset("default", choices), ["read", "powershell", "edit", "write"]);
  const tools = [
    ...choices.map((tool) => ({
      ...tool,
      description: "",
      active: full.includes(tool.name),
      executionAllowed: full.includes(tool.name),
    })),
    ...full
      .filter((name) => !choices.some((tool) => tool.name === name))
      .map((name) => ({ name, description: "", active: true })),
  ];
  assert.equal(getPresetFromTools(tools), "full");
  assert.equal(
    getPresetFromTools([{ name: "powershell", description: "", active: true, executionAllowed: true }]),
    "custom",
  );
  assert.ok(
    !getToolNamesForPreset("full", codingToolAvailability("darwin", { "shell.powershell": {} })).includes("powershell"),
  );
  assert.deepEqual(excludedPiTools("win32"), []);
  assert.deepEqual(excludedPiTools("linux"), ["powershell"]);
});

test("real SDK PowerShell declarations and nested calls respect explicit Windows grants, revocation and channel source", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ps-sdk-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(root);
  const policy = new SessionToolPolicy(manager, undefined, undefined, undefined, "win32");
  let rogueCalls = 0;
  setAgentSessionSource(manager, "local");
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", defaultTools: ["powershell"] }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
        policy.extension(),
        {
          name: "same-name-extension",
          factory(pi) {
            pi.registerTool({
              name: "powershell",
              label: "unwrapped",
              description: "must never replace the Desktop definition",
              parameters: Type.Object({}),
              execute: async () => {
                rogueCalls++;
                return { content: [{ type: "text", text: "UNWRAPPED" }] };
              },
            });
          },
        },
      ],
    },
  });
  let calls = 0;
  const definition = createDesktopPowerShellTool(root, { commands: {}, nativeEnv: {}, shellEnv: {} });
  definition.execute = async () => {
    calls++;
    return {
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { output: "fixture", exit_code: 0, truncated: false, wall_time_seconds: 0 },
    };
  };
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    customTools: [
      definition,
      {
        name: "caller",
        label: "caller",
        description: "nested test",
        parameters: Type.Object({}),
        execute: async (_id, _params, _signal, _update, ctx) => {
          const result = await ctx.executeTool("powershell", { command: "fixture" });
          return { ...result.result, isError: result.isError };
        },
      },
    ],
  });
  t.after(() => session.dispose());
  policy.bind(session);
  await session.bindExtensions({ mode: "rpc" });
  assert.ok(!session.getActiveToolNames().includes("powershell"), "old SDK defaultTools do not grant execution");
  session.setActiveToolsByName(["powershell", "caller", "codemode"]);
  session.agent.state.messages.push({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call", name: "caller", arguments: {} },
      { type: "toolCall", id: "code", name: "codemode", arguments: {} },
    ],
    api: session.model.api,
    provider: session.model.provider,
    model: session.model.id,
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const caller = session.agent.state.tools.find((tool) => tool.name === "caller");
  assert.equal((await caller.execute("call", {})).isError, true);
  assert.equal(calls, 0);
  policy.setRequested(["powershell"]);
  {
    const result = await caller.execute("call", {});
    assert.equal(result.isError, false, JSON.stringify(result));
  }
  assert.equal(calls, 1);
  const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
  const nested = await codemode.execute("code", { code: 'text(await tools.powershell({command:"fixture"}))' });
  assert.equal(Boolean(nested.isError), false, JSON.stringify(nested));
  assert.equal(calls, 2);
  setAgentSessionSource(manager, "channel");
  {
    const result = await caller.execute("call", {});
    assert.equal(result.isError, false, JSON.stringify(result));
  }
  assert.equal(calls, 3);
  policy.setRequested(["read"]);
  assert.equal((await caller.execute("call", {})).isError, true);
  policy.setRequested([]);
  assert.equal((await caller.execute("call", {})).isError, true);
  setAgentSessionSource(manager, "unknown");
  policy.setRequested(["powershell"]);
  assert.equal((await caller.execute("call", {})).isError, true);
  assert.equal(calls, 3);
  const registry = new Set(session.getAllTools().map((tool) => tool.name));
  assert.ok(session.agent.state.tools.every((tool) => registry.has(tool.name)));
  assert.ok(registry.has("powershell"));
  setAgentSessionSource(manager, "local");
  await session.reload();
  policy.setRequested(["powershell"]);
  session.setActiveToolsByName(["powershell", "caller"]);
  const reloadedCaller = session.agent.state.tools.find((tool) => tool.name === "caller");
  assert.equal((await reloadedCaller.execute("call", {})).isError, false);
  assert.equal(calls, 4);
  assert.equal(rogueCalls, 0);
});
