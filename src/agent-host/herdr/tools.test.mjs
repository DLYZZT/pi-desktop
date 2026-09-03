import assert from "node:assert/strict";
import test from "node:test";
import { HERDR_TOOL_NAMES, createHerdrToolDefinitions, herdrToolNamesForRuntime } from "./tools.ts";
import { setAgentSessionSource } from "../session-source.ts";

function runtime(status = "ready") {
  return {
    status,
    mode: "attach",
    version: "0.8.2",
    protocol: 20,
    schemaVersion: 1,
    sessionName: "default",
    capabilities: {
      readOnly: status === "ready",
      agentControl: status === "ready",
      terminalObserve: status === "ready",
      terminalControl: status === "ready",
      ansiOnly: true,
      graphics: false,
    },
    revision: 1,
  };
}

function fakeBridge() {
  const calls = [];
  const bridge = {
    calls,
    currentRuntime: runtime(),
    getRuntime() {
      return this.currentRuntime;
    },
    async refreshSnapshot() {
      calls.push(["list"]);
      return {
        revision: 2,
        receivedAt: 100,
        stale: false,
        focusedPaneId: "pane-a",
        workspaces: [
          {
            id: "workspace-a",
            focused: true,
            tabs: [{ id: "tab-a", workspaceId: "workspace-a", focused: true, paneIds: ["pane-a"] }],
          },
        ],
        panes: [
          {
            id: "pane-a",
            terminalId: "terminal-a",
            workspaceId: "workspace-a",
            tabId: "tab-a",
            focused: true,
            alive: true,
            revision: 1,
            agent: { kind: "codex", state: "idle" },
          },
        ],
      };
    },
    async createWorkspace(cwd, name) {
      calls.push(["create", cwd, name]);
      return { workspaceId: "workspace-new", rootPaneId: "pane-new" };
    },
    async focusWorkspace(id) {
      calls.push(["workspace-focus", id]);
      return { workspaceId: id };
    },
    async renameWorkspace(id, name) {
      calls.push(["workspace-rename", id, name]);
      return { workspaceId: id, name };
    },
    async closeWorkspace(id) {
      calls.push(["workspace-close", id]);
      return { workspaceId: id, closed: true };
    },
    async createTab(workspaceId, cwd, name, focus) {
      calls.push(["tab-create", workspaceId, cwd, name, focus]);
      return { workspaceId, tabId: "tab-new", rootPaneId: "pane-new" };
    },
    async focusTab(id) {
      calls.push(["tab-focus", id]);
      return { workspaceId: "workspace-a", tabId: id };
    },
    async renameTab(id, name) {
      calls.push(["tab-rename", id, name]);
      return { workspaceId: "workspace-a", tabId: id, name };
    },
    async splitPane(id, direction) {
      calls.push(["split", id, direction]);
      return { paneId: "pane-new" };
    },
    async readPane(id, maxBytes) {
      calls.push(["read", id, maxBytes]);
      return { text: "output", truncated: false };
    },
    async getPaneProcessInfo(id) {
      calls.push(["process-info", id]);
      return { paneId: id, processCount: 1, foregroundProcesses: [{ name: "node" }] };
    },
    async waitForPaneOutput(id, match, timeoutMs, requestId) {
      calls.push(["wait-output", id, match, timeoutMs, requestId]);
      return { paneId: id, matched: true, timedOut: false, matchedLine: "ready" };
    },
    async focusPane(id) {
      calls.push(["pane-focus", id]);
      return { paneId: id, workspaceId: "workspace-a", tabId: "tab-a" };
    },
    async renamePane(id, name) {
      calls.push(["pane-rename", id, name]);
      return { paneId: id, name };
    },
    async closePane(id) {
      calls.push(["pane-close", id]);
      return { paneId: id, workspaceId: "workspace-a", tabId: "tab-a", closed: true };
    },
    async startAgent(id, kind) {
      calls.push(["start", id, kind]);
      return { paneId: id, state: "idle" };
    },
    async explainAgent(id) {
      calls.push(["agent-explain", id]);
      return { paneId: id, detected: true, detection: { available: true } };
    },
    async focusAgent(id) {
      calls.push(["agent-focus", id]);
      return { paneId: id, agentKind: "codex" };
    },
    async renameAgent(id, name) {
      calls.push(["agent-rename", id, name]);
      return { paneId: id, agentKind: "codex", name };
    },
    async closeAgent(id) {
      calls.push(["agent-close", id]);
      return { paneId: id, agentKind: "codex", paneClosed: true };
    },
    async promptAgent(id, prompt) {
      calls.push(["prompt", id, prompt]);
      return { accepted: true };
    },
    async waitAgent(id, states, timeoutMs, requestId) {
      calls.push(["wait", id, states, timeoutMs, requestId]);
      return { state: "done", timedOut: false };
    },
    cancelWait(requestId) {
      calls.push(["cancel", requestId]);
    },
    async sendAgentKeys(id, keys) {
      calls.push(["keys", id, keys]);
      return { accepted: true };
    },
  };
  return bridge;
}

function toolContext(source = "local", confirmed = true) {
  const sessionManager = { getSessionId: () => "pi-session-a" };
  setAgentSessionSource(sessionManager, source);
  const confirmations = [];
  return {
    sessionManager,
    hasUI: true,
    confirmations,
    ui: {
      async confirm(title, message) {
        confirmations.push({ title, message });
        return confirmed;
      },
      async confirmLocalized(title, message, localization) {
        confirmations.push({ title, message, localization });
        return confirmed;
      },
    },
  };
}

test("Herdr tool registration is a strict semantic allowlist", () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...HERDR_TOOL_NAMES],
  );
  assert.equal(
    tools.some((tool) => /terminal_input|execute|shell|raw/i.test(tool.name)),
    false,
  );
  assert.deepEqual(herdrToolNamesForRuntime(bridge), [...HERDR_TOOL_NAMES]);
  bridge.currentRuntime = runtime("disabled");
  assert.deepEqual(herdrToolNamesForRuntime(bridge), []);
});

test("Herdr workspace and tab creation are fixed to the Pi project cwd and agent start has no arbitrary args", async () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  const create = tools.find((tool) => tool.name === "herdr_workspace_create");
  const createTab = tools.find((tool) => tool.name === "herdr_tab_create");
  const start = tools.find((tool) => tool.name === "herdr_agent_start");
  await create.execute("create-a", { name: "review" }, undefined, undefined, toolContext());
  await createTab.execute(
    "create-tab-a",
    { workspaceId: "workspace-a", name: "review tab", focus: true },
    undefined,
    undefined,
    toolContext(),
  );
  await start.execute("start-a", { paneId: "pane-a", kind: "codex" }, undefined, undefined, toolContext());
  assert.deepEqual(bridge.calls[0], ["create", "/project", "review"]);
  assert.deepEqual(bridge.calls[1], ["tab-create", "workspace-a", "/project", "review tab", true]);
  assert.deepEqual(bridge.calls[2], ["start", "pane-a", "codex"]);
  assert.equal("cwd" in createTab.parameters.properties, false);
  assert.equal("env" in createTab.parameters.properties, false);
});

test("Herdr tab focus and rename use exact semantic bridge methods", async () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  const focus = tools.find((tool) => tool.name === "herdr_tab_focus");
  const rename = tools.find((tool) => tool.name === "herdr_tab_rename");
  await focus.execute("focus-tab-a", { tabId: "tab-a" }, undefined, undefined, toolContext());
  await rename.execute("rename-tab-a", { tabId: "tab-a", name: "Implementation" }, undefined, undefined, toolContext());
  assert.deepEqual(bridge.calls, [
    ["tab-focus", "tab-a"],
    ["tab-rename", "tab-a", "Implementation"],
  ]);
});

test("new Herdr inspection, focus, and rename tools use fixed semantic bridge methods", async () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  const find = (name) => tools.find((tool) => tool.name === name);
  await find("herdr_agent_explain").execute("explain-a", { paneId: "pane-a" }, undefined, undefined, toolContext());
  const processResult = await find("herdr_pane_process_info").execute(
    "process-a",
    { paneId: "pane-a" },
    undefined,
    undefined,
    toolContext(),
  );
  await find("herdr_pane_wait_for_output").execute(
    "wait-output-a",
    { paneId: "pane-a", text: "ready", timeoutMs: 4_000 },
    undefined,
    undefined,
    toolContext(),
  );
  await find("herdr_workspace_focus").execute(
    "workspace-focus-a",
    { workspaceId: "workspace-a" },
    undefined,
    undefined,
    toolContext(),
  );
  await find("herdr_workspace_rename").execute(
    "workspace-rename-a",
    { workspaceId: "workspace-a", name: "Review" },
    undefined,
    undefined,
    toolContext(),
  );
  await find("herdr_pane_focus").execute("pane-focus-a", { paneId: "pane-a" }, undefined, undefined, toolContext());
  await find("herdr_pane_rename").execute(
    "pane-rename-a",
    { paneId: "pane-a", name: "Runner" },
    undefined,
    undefined,
    toolContext(),
  );
  await find("herdr_agent_focus").execute("agent-focus-a", { paneId: "pane-a" }, undefined, undefined, toolContext());
  await find("herdr_agent_rename").execute(
    "agent-rename-a",
    { paneId: "pane-a", name: "reviewer" },
    undefined,
    undefined,
    toolContext(),
  );
  assert.doesNotMatch(processResult.content[0].text, /cwd|argv|cmdline|pid|tty/i);
  assert.deepEqual(bridge.calls.slice(0, 2), [
    ["agent-explain", "pane-a"],
    ["process-info", "pane-a"],
  ]);
  assert.deepEqual(bridge.calls[2].slice(0, 4), ["wait-output", "pane-a", "ready", 4_000]);
  assert.match(bridge.calls[2][4], /^[0-9a-f-]{36}$/);
  assert.deepEqual(bridge.calls.slice(3), [
    ["workspace-focus", "workspace-a"],
    ["workspace-rename", "workspace-a", "Review"],
    ["pane-focus", "pane-a"],
    ["pane-rename", "pane-a", "Runner"],
    ["agent-focus", "pane-a"],
    ["agent-rename", "pane-a", "reviewer"],
  ]);
});

test("Herdr close tools require local UI confirmation and describe destructive scope", async () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  const closePane = tools.find((tool) => tool.name === "herdr_pane_close");
  const closeWorkspace = tools.find((tool) => tool.name === "herdr_workspace_close");
  const closeAgent = tools.find((tool) => tool.name === "herdr_agent_close");
  const noUiSessionManager = { getSessionId: () => "pi-session-no-ui" };
  setAgentSessionSource(noUiSessionManager, "local");
  await assert.rejects(
    closePane.execute("close-no-ui", { paneId: "pane-a" }, undefined, undefined, {
      sessionManager: noUiSessionManager,
      hasUI: false,
      ui: undefined,
    }),
    /HERDR_CONFIRMATION_REQUIRED/,
  );
  const denied = toolContext("local", false);
  await assert.rejects(
    closePane.execute("close-denied", { paneId: "pane-a" }, undefined, undefined, denied),
    /HERDR_REQUEST_CANCELLED/,
  );
  assert.match(denied.confirmations[0].message, /terminate its shell, Agent, and other processes/);
  assert.deepEqual(denied.confirmations[0].localization, { id: "herdr.closePane", target: "pane-a" });
  assert.equal(
    bridge.calls.some(([method]) => method === "pane-close"),
    false,
  );

  const workspaceContext = toolContext();
  await closeWorkspace.execute(
    "close-workspace",
    { workspaceId: "workspace-a" },
    undefined,
    undefined,
    workspaceContext,
  );
  const paneContext = toolContext();
  await closePane.execute("close-pane", { paneId: "pane-a" }, undefined, undefined, paneContext);
  const agentContext = toolContext();
  await closeAgent.execute("close-agent", { paneId: "pane-a" }, undefined, undefined, agentContext);
  assert.match(workspaceContext.confirmations[0].message, /terminate 1 pane/);
  assert.deepEqual(workspaceContext.confirmations[0].localization, {
    id: "herdr.closeWorkspace",
    target: "workspace-a",
    paneCount: 1,
  });
  assert.match(agentContext.confirmations[0].message, /cannot stop only the Agent/);
  assert.deepEqual(agentContext.confirmations[0].localization, {
    id: "herdr.closeAgentPane",
    paneId: "pane-a",
    agentKind: "codex",
  });
  assert.deepEqual(
    bridge.calls.filter(([method]) => ["workspace-close", "pane-close", "agent-close"].includes(method)),
    [
      ["workspace-close", "workspace-a"],
      ["pane-close", "pane-a"],
      ["agent-close", "pane-a"],
    ],
  );
});

test("Herdr tools fail closed for messaging-channel turns", async () => {
  const bridge = fakeBridge();
  const status = createHerdrToolDefinitions("/project", bridge).find((tool) => tool.name === "herdr_status");
  await assert.rejects(
    status.execute("status-a", {}, undefined, undefined, toolContext("channel")),
    /HERDR_DISABLED: Herdr tools are unavailable for messaging-channel turns/,
  );
  await assert.rejects(
    status.execute("status-unknown", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "pi-session-unknown" },
    }),
    /HERDR_DISABLED: Herdr tools are unavailable for messaging-channel turns/,
  );
});

test("Herdr list refreshes state and agent control uses semantic bridge methods", async () => {
  const bridge = fakeBridge();
  const tools = createHerdrToolDefinitions("/project", bridge);
  const list = tools.find((tool) => tool.name === "herdr_list");
  const prompt = tools.find((tool) => tool.name === "herdr_agent_prompt");
  const keys = tools.find((tool) => tool.name === "herdr_agent_keys");
  const wait = tools.find((tool) => tool.name === "herdr_agent_wait");
  const listResult = await list.execute("list-a", { state: "idle" }, undefined, undefined, toolContext());
  await prompt.execute(
    "prompt-a",
    { paneId: "pane-a", prompt: "review this project" },
    undefined,
    undefined,
    toolContext(),
  );
  await keys.execute("keys-a", { paneId: "pane-a", keys: ["esc", "ctrl+c"] }, undefined, undefined, toolContext());
  await wait.execute(
    "wait-a",
    { paneId: "pane-a", states: ["done"], timeoutMs: 5_000 },
    undefined,
    undefined,
    toolContext(),
  );
  assert.match(listResult.content[0].text, /"pane-a"/);
  assert.deepEqual(bridge.calls.slice(0, 3), [
    ["list"],
    ["prompt", "pane-a", "review this project"],
    ["keys", "pane-a", ["esc", "ctrl+c"]],
  ]);
  assert.deepEqual(bridge.calls[3].slice(0, 4), ["wait", "pane-a", ["done"], 5_000]);
  assert.match(bridge.calls[3][4], /^[0-9a-f-]{36}$/);
});
