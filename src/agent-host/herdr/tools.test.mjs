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
    async startAgent(id, kind) {
      calls.push(["start", id, kind]);
      return { paneId: id, state: "idle" };
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

function toolContext(source = "local") {
  const sessionManager = { getSessionId: () => "pi-session-a" };
  setAgentSessionSource(sessionManager, source);
  return { sessionManager };
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
