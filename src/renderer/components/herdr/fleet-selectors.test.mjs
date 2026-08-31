import assert from "node:assert/strict";
import test from "node:test";
import { countHerdrAgents, herdrPaneMatchesFilter } from "./fleet-selectors.ts";

const shellPane = {
  id: "shell",
  terminalId: "terminal-shell",
  workspaceId: "workspace",
  tabId: "tab",
  focused: false,
  alive: true,
  revision: 1,
};
const agentPane = {
  ...shellPane,
  id: "agent",
  terminalId: "terminal-agent",
  agent: { kind: "codex", state: "blocked" },
};
const doneAlivePane = {
  ...shellPane,
  id: "done-alive",
  terminalId: "terminal-done-alive",
  alive: true,
  agent: { kind: "claude", state: "done" },
};

test("Fleet counts only detected agents while all-filter still exposes shell panes", () => {
  assert.deepEqual(countHerdrAgents([shellPane, agentPane]), {
    working: 0,
    blocked: 1,
    idle: 0,
    done: 0,
    unknown: 0,
  });
  assert.equal(herdrPaneMatchesFilter(shellPane, "all"), true);
  assert.equal(herdrPaneMatchesFilter(shellPane, "idle"), false);
  assert.equal(herdrPaneMatchesFilter(agentPane, "blocked"), true);
});

test("a done Agent remains countable and selectable while its pane is alive", () => {
  assert.equal(countHerdrAgents([doneAlivePane]).done, 1);
  assert.equal(herdrPaneMatchesFilter(doneAlivePane, "done"), true);
  assert.equal(herdrPaneMatchesFilter(doneAlivePane, "all"), true);
});
