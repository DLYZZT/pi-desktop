import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { PRESET_FULL, PRESET_DEFAULT } from "../shared/tool-presets.ts";

const {
  applySessionToolCommand,
  sessionOrchestrationExtensions,
  withSessionOrchestration,
  withExtensionTools,
  DesktopSessionToolStore,
  SessionToolPolicy,
  setAgentSessionSource,
  SessionExecutionHistory,
} = await importTestBundle("session-tool-settings", {
  packages: "external",
  stdin: {
    contents:
      'export {applySessionToolCommand} from "./session-tool-settings.ts"; export {sessionOrchestrationExtensions,withSessionOrchestration} from "./session-orchestration.ts"; export {withExtensionTools} from "./tool-activation.ts"; export {DesktopSessionToolStore} from "./session-tool-store.ts"; export {SessionToolPolicy} from "./session-tool-policy.ts"; export {setAgentSessionSource} from "./session-source.ts"; export {SessionExecutionHistory} from "./session-execution-history.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("Full access and entry toggles never grant MCP or deferred child permissions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-tools-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "session-tools.json"),
    store = new DesktopSessionToolStore(filename);
  const definitions = [
    ...PRESET_FULL.map((name) => ({
      name,
      exposure: ["codemode", "tool_search"].includes(name) ? "model-only" : "direct",
      defaultActive: false,
    })),
    { name: "mcp__fixture__echo", exposure: "deferred" },
    { name: "protected_step", exposure: "deferred" },
  ];
  let active = PRESET_DEFAULT,
    requested = PRESET_DEFAULT;
  const session = {
    getAllTools: () => definitions,
    getToolDefinition: (name) => definitions.find((tool) => tool.name === name),
    getActiveToolNames: () => active,
    getCallableToolNames: () => definitions.map((tool) => tool.name),
  };
  const manager = {},
    policy = new SessionToolPolicy(manager, requested);
  setAgentSessionSource(manager, "local");
  policy.bind(session);
  store.set("fixture", requested);
  const context = {
    sessionId: "fixture",
    session,
    policy,
    preferences: store,
    get requested() {
      return requested;
    },
    apply: (names) => {
      requested = names;
      policy.setRequested(names);
      active = withSessionOrchestration(session, withExtensionTools(session, names), store.getOrchestration("fixture"));
    },
  };
  applySessionToolCommand(context, { type: "set_tools", toolNames: PRESET_FULL });
  assert.equal(policy.isAllowed("codemode"), true);
  assert.equal(policy.isAllowed("tool_search"), true);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), false);
  assert.equal(policy.isAllowed("protected_step"), false);
  store.setMcpExecution("fixture", ["mcp__fixture__echo"]);
  policy.setMcpExecution(["mcp__fixture__echo"]);
  applySessionToolCommand(context, { type: "set_orchestration_tools", toolNames: ["tool_search"] });
  assert.equal(policy.isAllowed("codemode"), false);
  assert.equal(policy.isAllowed("tool_search"), true);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), true);
  assert.equal(policy.isAllowed("protected_step"), false);
  const before = readFileSync(filename, "utf8");
  assert.throws(
    () => applySessionToolCommand(context, { type: "set_orchestration_tools", toolNames: ["mcp__fixture__echo"] }),
    /Invalid orchestration/,
  );
  assert.throws(
    () => applySessionToolCommand(context, { type: "set_orchestration_tools", toolNames: ["powershell"] }),
    /not supported/,
  );
  assert.equal(readFileSync(filename, "utf8"), before);
  applySessionToolCommand(context, { type: "set_tools", toolNames: [] });
  assert.equal(policy.isAllowed("codemode"), false);
  assert.equal(policy.isAllowed("mcp__fixture__echo"), false);
  assert.throws(
    () => applySessionToolCommand(context, { type: "set_orchestration_tools", toolNames: ["codemode"] }),
    /Enable a tool preset/,
  );
});

test("without MCP, full access runs real Codemode and tool_search while child hooks remain enforced", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-generic-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "original.txt");
  writeFileSync(file, "GENERIC_ORIGINAL_原文");
  const store = new DesktopSessionToolStore(path.join(root, "session-tools.json")),
    manager = SessionManager.inMemory(root);
  const policy = new SessionToolPolicy(manager, PRESET_FULL),
    history = new SessionExecutionHistory(manager, root);
  setAgentSessionSource(manager, "local");
  let effects = 0;
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", extensions: ["-builtin:mcp"] }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        policy.extension(),
        history.extension(),
        ...sessionOrchestrationExtensions((id) => store.getOrchestration(id)),
      ],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-orchestration-fixture");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
    excludeTools: ["powershell"],
    customTools: [
      {
        name: "protected_step",
        label: "Protected fixture",
        description: "protected marker fixture step",
        exposure: "deferred",
        parameters: Type.Object({}),
        execute: async () => {
          effects++;
          return { content: [{ type: "text", text: "EXECUTED" }], details: {} };
        },
      },
    ],
  });
  t.after(() => session.dispose());
  policy.bind(session);
  const context = {
    sessionId: manager.getSessionId(),
    session,
    policy,
    preferences: store,
    apply: (names) => {
      policy.setRequested(names);
      session.setActiveToolsByName(
        withSessionOrchestration(
          session,
          withExtensionTools(session, names),
          store.getOrchestration(manager.getSessionId()),
        ),
      );
    },
  };
  applySessionToolCommand(context, { type: "set_tools", toolNames: PRESET_FULL });
  await session.bindExtensions({ mode: "rpc" });
  assert.equal(
    session.getAllTools().some((tool) => tool.name.startsWith("mcp__")),
    false,
  );
  assert.equal(session.getActiveToolNames().includes("codemode"), true);
  assert.equal(session.getActiveToolNames().includes("tool_search"), true);
  const run = async (name, args) => {
    let count = 0;
    session.agent.streamFunction = (model) => {
      const first = ++count === 1,
        stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: first
          ? [{ type: "toolCall", id: "fixture-" + session.messages.length, name, arguments: args }]
          : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: first ? "toolUse" : "stop",
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
      void Promise.resolve().then(() => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    };
    await session.prompt("Run the generic fixture", { source: "rpc" });
  };
  await run("codemode", {
    code: `text(await tools.read({path: ${JSON.stringify(file)}})); try { await tools.protected_step({}); } catch (error) { text(error.message); }`,
  });
  const page = await history.query({ includeContent: true });
  assert.ok(
    page.records.some(
      (record) =>
        record.toolName === "read" &&
        record.status === "succeeded" &&
        JSON.stringify(record.result).includes("GENERIC_ORIGINAL_原文"),
    ),
  );
  assert.ok(page.records.some((record) => record.toolName === "protected_step" && record.status === "blocked"));
  assert.equal(effects, 0);
  await run("tool_search", { query: "protected marker fixture" });
  assert.equal(session.getActiveToolNames().includes("protected_step"), true);
  assert.equal(policy.isAllowed("protected_step"), false);
  applySessionToolCommand(context, { type: "set_execution_tools", toolNames: ["protected_step"] });
  await run("codemode", { code: "text(await tools.protected_step({}));" });
  assert.equal(effects, 1);
  assert.ok(
    (await history.query()).records.some(
      (record) => record.toolName === "protected_step" && record.status === "succeeded",
    ),
  );
  setAgentSessionSource(manager, "channel");
  assert.equal(policy.isAllowed("codemode"), false);
  assert.equal(policy.isAllowed("tool_search"), false);
});
