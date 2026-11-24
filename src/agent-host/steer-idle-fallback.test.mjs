import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { AgentSessionWrapper } = await importTestBundle("pi-steer-idle-fallback", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export {AgentSessionWrapper} from "./rpc-manager.ts";',
  },
});

/**
 * Bypass the constructor (it wires real SDK services). `send()` only needs
 * these fields; TS `private` members are plain properties after bundling.
 * The fake inner records which command actually reached the agent.
 */
function makeWrapper({ streaming = false } = {}) {
  const calls = [];
  const branch = [];
  const sections = [];
  const appendCustomEntry = (customType, data) => {
    const entry = { id: `e-${branch.length}`, type: "custom", customType, data };
    branch.push(entry);
    return entry.id;
  };
  const inner = {
    sessionId: "fixture-session",
    sessionFile: "",
    isStreaming: streaming,
    isCompacting: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    pendingMessageCount: 0,
    model: undefined,
    systemPrompt: "",
    agent: { state: {} },
    getContextUsage: () => undefined,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    sessionManager: { getBranch: () => branch, appendCustomEntry },
    async prompt(message, options) {
      calls.push({ kind: "prompt", message, options });
    },
    async steer(message) {
      calls.push({ kind: "steer", message });
    },
    async followUp(message) {
      calls.push({ kind: "followUp", message });
    },
    async abort() {
      calls.push({ kind: "abort" });
    },
    async sendCustomMessage(message, options) {
      calls.push({ kind: "custom", message, options });
    },
  };
  const wrapper = Object.create(AgentSessionWrapper.prototype);
  Object.assign(wrapper, {
    inner,
    listeners: [],
    _alive: true,
    promptRunning: false,
    queuedTurnCount: 0,
    turnTail: Promise.resolve(),
    forceEmptySystemPrompt: false,
    extensionStatuses: new Map(),
    runtimeDiagnosticStatuses: new Map(),
    extensionWidgets: new Map(),
    promptPolicy: { setGoalSection: (section) => sections.push(section), resolve: (value) => value },
    modelSelection: { assertReady: () => {}, snapshot: () => undefined },
    modelConfig: { sync: async () => {} },
  });
  wrapper.resetIdleTimer = () => {};
  wrapper.shouldWaitForExtensions = () => false;
  return { wrapper, calls, branch, sections };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("an idle steer starts a prompt instead of stranding the message in the queue", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "steer", message: "hello" });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["prompt"],
    "idle steer must not call inner.steer (nothing would consume the queue entry)",
  );
  assert.equal(calls[0].message, "hello");
  assert.deepEqual(calls[0].options, { source: "rpc" });
});

test("an idle follow_up starts a prompt too", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "follow_up", message: "next" });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["prompt"],
  );
  assert.equal(calls[0].message, "next");
});

test("a mid-turn steer still queues into the running turn", async () => {
  const { wrapper, calls } = makeWrapper({ streaming: true });
  await wrapper.send({ type: "steer", message: "mid-turn" });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["steer"],
  );
  assert.equal(calls[0].message, "mid-turn");
});

test("normalized commands do not inherit streamingBehavior", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "steer", message: "x", streamingBehavior: "followUp" });
  await settle();
  assert.equal(calls[0].kind, "prompt");
  assert.deepEqual(calls[0].options, { source: "rpc" }, "stale streamingBehavior must be dropped");
});

test("goal accept records the decision without starting another turn", async () => {
  const { wrapper, calls, branch } = makeWrapper();
  await wrapper.send({ type: "goal_resolve", action: "accept" });
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(branch.at(-1).customType, "pi-desktop-goal");
  assert.deepEqual(branch.at(-1).data, { kind: "resolve", action: "accept" });
});

test("goal stop aborts only a running turn", async () => {
  const idle = makeWrapper();
  await idle.wrapper.send({ type: "goal_resolve", action: "stop" });
  assert.deepEqual(idle.calls, []);

  const running = makeWrapper({ streaming: true });
  await running.wrapper.send({ type: "goal_resolve", action: "stop" });
  assert.deepEqual(
    running.calls.map((call) => call.kind),
    ["abort"],
  );
});

test("goal reject resumes an idle goal with the trimmed feedback", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "goal_resolve", action: "reject", feedback: "  tests still fail  " });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "custom");
  assert.match(calls[0].message.content, /tests still fail/);
  assert.doesNotMatch(calls[0].message.content, / {2}tests still fail {2}/);
  assert.equal(calls[0].message.display, false);
  assert.deepEqual(calls[0].options, { triggerTurn: true });
});

test("goal extend grants a fixed number of turns and does not resume when a turn is running", async () => {
  const idle = makeWrapper();
  await idle.wrapper.send({ type: "goal_resolve", action: "extend" });
  await settle();
  assert.deepEqual(idle.branch.at(-1).data, { kind: "resolve", action: "extend", extra: 4 });
  assert.equal(idle.calls[0].kind, "custom");

  const running = makeWrapper({ streaming: true });
  await running.wrapper.send({ type: "goal_resolve", action: "extend" });
  assert.equal(running.calls.length, 0, "a running turn keeps its own loop");
});

test("unknown goal actions are rejected before touching the session", async () => {
  const { wrapper, branch } = makeWrapper();
  await assert.rejects(wrapper.send({ type: "goal_resolve", action: "approve" }), /Invalid goal action/);
  assert.deepEqual(branch, []);
});

test("get_state exposes the goal derived from the branch", async () => {
  const { wrapper, branch, sections } = makeWrapper();
  branch.push({
    id: "start-1",
    type: "custom",
    customType: "pi-desktop-goal",
    data: {
      kind: "start",
      goal: "Fixture goal",
      criteria: ["tests pass"],
      maxContinuations: 8,
      checkpointEvery: 4,
    },
  });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.goalState.goal, "Fixture goal");
  assert.equal(state.goalState.status, "working");
  assert.deepEqual(state.goalState.criteria, ["tests pass"]);
  assert.match(sections.at(-1), /Goal: Fixture goal/);
});
