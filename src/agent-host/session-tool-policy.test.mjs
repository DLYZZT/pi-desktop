import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getModel } from "@earendil-works/pi-ai/compat";
const { SessionToolPolicy, withExtensionTools, setAgentSessionSource } = await importTestBundle("session-tool-policy", {
  packages: "external",
  stdin: {
    contents:
      'export {SessionToolPolicy} from "./session-tool-policy.ts"; export {withExtensionTools} from "./tool-activation.ts"; export {setAgentSessionSource} from "./session-source.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
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
