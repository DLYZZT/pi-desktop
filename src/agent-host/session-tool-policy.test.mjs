import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MessageChannel } from "node:worker_threads";
import { createRpcClient, createRpcServer } from "../contract/rpc.ts";
import { createDeferred } from "#test-timing";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getModel } from "@earendil-works/pi-ai/compat";
const {
  SessionToolPolicy,
  withExtensionTools,
  setAgentSessionSource,
  sessionOrchestrationExtensions,
  AgentSessionWrapper,
  applySessionToolCommand,
  DesktopSessionToolStore,
} = await importTestBundle("session-tool-policy", {
  packages: "external",
  stdin: {
    contents:
      'export {SessionToolPolicy} from "./session-tool-policy.ts"; export {withExtensionTools} from "./tool-activation.ts"; export {setAgentSessionSource} from "./session-source.ts"; export {sessionOrchestrationExtensions} from "./session-orchestration.ts"; export {AgentSessionWrapper} from "./rpc-manager.ts"; export {applySessionToolCommand} from "./session-tool-settings.ts"; export {DesktopSessionToolStore} from "./session-tool-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("1.2.0 tools remain host-callable while tool-list and permission RPCs expose only cloneable metadata", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-120-tool-wire-"));
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: sessionOrchestrationExtensions(() => undefined),
    },
  });
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    excludeTools: ["powershell"],
  });
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager, ["read", "codemode", "tool_search"]);
  policy.bind(session);
  const wrapper = new AgentSessionWrapper(
    session,
    ["read", "codemode", "tool_search"],
    () => {},
    undefined,
    undefined,
    policy,
  );
  const store = new DesktopSessionToolStore(path.join(cwd, "session-tools.json"));
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer();
  server.attachPort(port1);
  const client = createRpcClient(port2);
  server.handle({
    "agent.command": ({ command }) =>
      command.type === "get_tools"
        ? wrapper.send(command)
        : applySessionToolCommand(
            {
              sessionId: session.sessionId,
              session,
              policy,
              preferences: store,
              requested: ["read", "codemode", "tool_search"],
              apply(names) {
                policy.setRequested(names);
                session.setActiveToolsByName(names);
              },
            },
            command,
          ),
  });
  t.after(() => {
    client.close();
    server.detachPort(port1);
    port1.close();
    port2.close();
    wrapper.destroy();
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  for (const phase of ["new", "reload"]) {
    if (phase === "reload") await session.reload();
    const original = session.getAllTools.bind(session);
    assert.equal(typeof original().find((tool) => tool.name === "codemode").reachesTools, "function");
    const spy = t.mock.method(session, "getAllTools", () =>
      original().map((tool) => ({
        ...tool,
        sourceInfo: { ...tool.sourceInfo, path: "/private/fixture-extension-do-not-send" },
        promptGuidelines: ["/private/fixture-extension-do-not-send"],
      })),
    );
    for (const active of [["read"], ["read", "codemode", "tool_search"]]) {
      session.setActiveToolsByName(active);
      for (const command of [
        { type: "get_tools" },
        { type: "set_execution_tools", toolNames: [] },
        { type: "set_orchestration_tools", toolNames: ["codemode"] },
      ]) {
        const result = await client.call("agent.command", { sessionId: session.sessionId, command });
        assert.ok(result.some((tool) => tool.name === "codemode"));
        assert.ok(!result.some((tool) => tool.name === "powershell"));
        assert.ok(!JSON.stringify(result).includes("fixture-extension-do-not-send"));
        for (const tool of result)
          for (const field of ["parameters", "sourceInfo", "promptGuidelines", "reachesTools"])
            assert.equal(Object.hasOwn(tool, field), false, `${phase}: ${field}`);
      }
    }
    spy.mock.restore();
  }
});

test("default declaration respects exposure and defaultActive while explicit tools remain selectable", () => {
  const tools = ["direct", "model-only", "deferred", "codemode", "hidden"].map((exposure) => ({
    name: exposure,
    exposure,
  }));
  tools.push({ name: "inactive", exposure: "direct" });
  const session = { getAllTools: () => tools, getToolDefinition: (name) => ({ defaultActive: name !== "inactive" }) };
  assert.deepEqual(withExtensionTools(session, ["read"]), ["read", "direct", "model-only"]);
  assert.deepEqual(withExtensionTools(session, ["read", "inactive"]), ["read", "inactive", "direct", "model-only"]);
  assert.deepEqual(withExtensionTools(session, []), []);
});

test("MCP scoped authorization does not persist or revoke other Desktop tool capabilities", () => {
  const manager = {},
    definitions = [
      { name: "ordinary", exposure: "direct" },
      { name: "herdr_list", exposure: "direct" },
      { name: "mcp__fixture__echo", exposure: "deferred" },
      { name: "mcp__fixture__direct", exposure: "direct", defaultActive: true },
      { name: "codemode", exposure: "model-only", defaultActive: false },
    ];
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager);
  policy.bind({
    getActiveToolNames: () => ["ordinary", "herdr_list", "codemode", "mcp__fixture__direct"],
    getAllTools: () => definitions,
    getToolDefinition: (name) => definitions.find((tool) => tool.name === name),
  });
  assert.equal(policy.isAllowed("herdr_list"), true);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), false);
  assert.equal(policy.isAllowed("mcp__fixture__direct"), false);
  policy.setMcpExecution(["mcp__fixture__echo", "codemode"]);
  assert.equal(policy.isAllowed("ordinary"), true);
  assert.equal(policy.isAllowed("herdr_list"), true);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), true);
  policy.setMcpExecution([]);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), false);
  assert.equal(policy.isAllowed("ordinary"), true);
  policy.setRequested([]);
  assert.equal(policy.isAllowed("ordinary"), false);
  assert.equal(policy.isAllowed("herdr_list"), false);
});

test("MCP readiness and aliases never grant permission, and revocation is rechecked after waiting", async () => {
  const manager = {},
    name = "mcp__fixture__echo",
    entered = createDeferred(),
    ready = createDeferred();
  const tool = {
    name,
    description: "echo",
    exposure: "deferred",
    namespace: { name: "mcp__fixture", aliases: ["fixture"] },
  };
  const policy = new SessionToolPolicy(manager, ["read"]);
  setAgentSessionSource(manager, "local");
  policy.bind({
    getAllTools: () => [tool],
    getToolDefinition: () => tool,
    getActiveToolNames: () => ["read"],
    getCallableToolNames: () => [name],
  });
  assert.equal(policy.isAllowed(name), false);
  policy.setMcpExecution([name]);
  let hook;
  policy.extension().factory({
    on(event, callback) {
      if (event === "tool_call") hook = callback;
    },
  });
  policy.setMcpPreparation(async () => {
    entered.resolve();
    await ready.promise;
  });
  const pending = hook({ toolName: name, input: {}, toolCallId: "waiting" }, { hasUI: false });
  await entered.promise;
  policy.setMcpExecution([]);
  ready.resolve();
  assert.equal((await pending).block, true);
  policy.setRequested([]);
  policy.setMcpPreparation(async () => assert.fail("empty sessions must not prepare connections"));
  assert.equal((await hook({ toolName: name, input: {}, toolCallId: "empty" }, { hasUI: true })).block, true);
});

test("MCP confirmation that outlives a switch to a channel cannot authorize the call", async () => {
  const manager = {},
    name = "mcp__fixture__echo",
    entered = createDeferred(),
    approve = createDeferred();
  const tool = { name, description: "echo", exposure: "deferred" };
  const policy = new SessionToolPolicy(manager, ["read"]);
  setAgentSessionSource(manager, "local");
  policy.bind({ getAllTools: () => [tool], getToolDefinition: () => tool, getActiveToolNames: () => ["read"] });
  let hook;
  policy.extension().factory({
    on(event, callback) {
      if (event === "tool_call") hook = callback;
    },
  });
  policy.setMcpAuthorizer(async (_name, _input, _ctx, valid) => {
    entered.resolve();
    await approve.promise;
    assert.equal(valid(), false);
    return true;
  });
  const pending = hook({ toolName: name, input: {}, toolCallId: "approval" }, { hasUI: true });
  await entered.promise;
  setAgentSessionSource(manager, "channel");
  approve.resolve();
  assert.equal((await pending).block, true);
  assert.equal(policy.isAllowed(name), false);
});

test("local MCP orchestration can reach first-use approval while headless and empty sessions stay blocked", () => {
  const manager = {},
    tools = [
      { name: "codemode", exposure: "model-only" },
      { name: "tool_search", exposure: "model-only" },
      { name: "mcp__server__echo", exposure: "codemode" },
    ];
  const policy = new SessionToolPolicy(manager);
  policy.bind({
    getActiveToolNames: () => ["codemode", "tool_search"],
    getAllTools: () => tools,
    getToolDefinition: (name) => tools.find((tool) => tool.name === name),
  });
  setAgentSessionSource(manager, "local");
  assert.equal(policy.isAllowed("codemode"), true);
  assert.equal(policy.isAllowed("tool_search"), true);
  assert.equal(policy.isAllowed("mcp__server__echo"), false);
  setAgentSessionSource(manager, "channel");
  assert.equal(policy.isAllowed("codemode"), false);
  assert.equal(policy.isAllowed("tool_search"), false);
  setAgentSessionSource(manager, "local");
  policy.setRequested([]);
  assert.equal(policy.isAllowed("codemode"), false);
});

test("actual SDK nested calls respect grants, source changes, no-tools and immediate revocation", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-tool-policy-")),
    manager = SessionManager.inMemory(cwd);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager, ["read"]);
  let executed = 0;
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [policy.extension()],
    },
  });
  const target = (name, exposure) => ({
    name,
    label: name,
    description: name,
    exposure,
    parameters: Type.Object({}),
    execute: async () => {
      executed++;
      return { content: [{ type: "text", text: "result" }], details: {} };
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: getModel("anthropic", "claude-sonnet-5-5"),
    customTools: [
      {
        name: "caller",
        label: "Caller",
        description: "Fixture caller",
        parameters: Type.Object({ target: Type.String() }),
        async execute(_id, params, _signal, _update, ctx) {
          const outcome = await ctx.executeTool(params.target, {});
          return { ...outcome.result, isError: outcome.isError };
        },
      },
      target("target", "deferred"),
      target("hidden_target", "hidden"),
      target("process_read", "direct"),
      target("herdr_agent_prompt", "direct"),
    ],
  });
  t.after(() => session.dispose());
  policy.bind(session);
  session.setActiveToolsByName(["read", "caller", "process_read", "herdr_agent_prompt"]);
  await session.bindExtensions({ mode: "rpc" });
  const model = session.model;
  session.agent.state.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: "caller", name: "caller", arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  const call = (name) => caller.execute("caller", { target: name }, new globalThis.AbortController().signal);
  assert.ok(session.getCallableToolNames().includes("target"));
  assert.equal((await call("target")).isError, true);
  assert.equal(executed, 0);
  policy.setExecution(["target", "process_read", "herdr_agent_prompt"]);
  assert.equal((await call("target")).isError, false);
  assert.equal(executed, 1);
  setAgentSessionSource(manager, "channel");
  assert.equal((await call("process_read")).isError, true);
  assert.equal((await call("herdr_agent_prompt")).isError, true);
  policy.setExecution([]);
  assert.equal((await call("target")).isError, true);
  policy.setExecution(["target"]);
  policy.setRequested([]);
  assert.equal((await call("target")).isError, true);
  assert.equal((await call("hidden_target")).isError, true);
  assert.equal((await call("powershell")).isError, true);
  assert.equal(executed, 1);
  const state = policy.describe().find((tool) => tool.name === "target");
  assert.equal(state.active, false);
  assert.equal(state.callable, true);
  assert.equal(state.executionAllowed, false);
  assert.equal(
    policy.describe().some((tool) => tool.name === "hidden_target"),
    false,
  );
  policy.setRequested(["read"]);
  assert.equal(policy.isAllowed("caller"), true);
  assert.equal(policy.isAllowed("target"), false);
});
