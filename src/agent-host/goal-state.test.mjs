import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const {
  CHECKPOINT_EVERY,
  DEFAULT_MAX_CONTINUATIONS,
  EXTEND_STEP,
  GOAL_CUSTOM_TYPE,
  GOAL_REPORT_TOOL_NAME,
  goalPromptSection,
  readSessionGoalState,
  syncGoalPromptSection,
} = await importTestBundle("goal-state", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export * from "./goal-state.ts";',
  },
});

let nextId = 0;
const id = () => `e-${++nextId}`;

function custom(data) {
  return { id: id(), type: "custom", customType: GOAL_CUSTOM_TYPE, data };
}

function start(overrides = {}) {
  return custom({
    kind: "start",
    goal: "Ship the fixture",
    criteria: ["tests pass", "docs updated"],
    maxContinuations: DEFAULT_MAX_CONTINUATIONS,
    checkpointEvery: CHECKPOINT_EVERY,
    ...overrides,
  });
}

const continued = () => custom({ kind: "continue" });
const exhausted = () => custom({ kind: "budget_exhausted" });
const resolved = (action, extra = {}) => custom({ kind: "resolve", action, ...extra });

function report(criteria, extra = {}) {
  return {
    id: id(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: GOAL_REPORT_TOOL_NAME,
      content: [],
      details: { summary: "Fixture summary", criteria },
      ...extra,
    },
  };
}

const reportedCriteria = [
  { criterion: "tests pass", met: true, evidence: "npm test: 120 passing" },
  { criterion: "docs updated", met: false, evidence: "" },
];

function read(path) {
  return readSessionGoalState({ getBranch: () => path });
}

test("a branch without a goal start has no state", () => {
  assert.equal(read([]), null);
  assert.equal(read([report(reportedCriteria)]), null, "a report before any start is stale");
  assert.equal(
    read([{ id: id(), type: "custom", customType: "pi-desktop-agent-settled", data: { version: 1 } }]),
    null,
  );
});

test("start derives a working goal with its criteria and budget", () => {
  const state = read([start()]);
  assert.deepEqual(state, {
    goal: "Ship the fixture",
    criteria: ["tests pass", "docs updated"],
    status: "working",
    continuations: 0,
    maxContinuations: DEFAULT_MAX_CONTINUATIONS,
    checkpointEvery: CHECKPOINT_EVERY,
    report: null,
    feedback: null,
  });
});

test("continuations count on this branch only", () => {
  const state = read([continued(), start(), continued(), continued()]);
  assert.equal(state.status, "working");
  assert.equal(state.continuations, 2);
});

test("a goal_report waits for user acceptance and carries the criteria", () => {
  const state = read([start(), continued(), report(reportedCriteria)]);
  assert.equal(state.status, "awaiting_acceptance");
  assert.deepEqual(state.report, { summary: "Fixture summary", criteria: reportedCriteria });
});

test("a failed report does not open acceptance", () => {
  const state = read([start(), report(reportedCriteria, { isError: true })]);
  assert.equal(state.status, "working");
  assert.equal(state.report, null);
});

test("malformed reports are ignored rather than rendered", () => {
  const malformed = report(undefined);
  malformed.message.details = { criteria: [{ criterion: "", met: "yes", evidence: 1 }] };
  assert.equal(read([start(), malformed]).status, "working");
});

test("a send-back clears the old report and keeps the feedback", () => {
  const state = read([start(), report(reportedCriteria), resolved("reject", { feedback: "docs are missing" })]);
  assert.equal(state.status, "working");
  assert.equal(state.report, null);
  assert.equal(state.feedback, "docs are missing");
});

test("accept and stop are terminal", () => {
  assert.equal(read([start(), report(reportedCriteria), resolved("accept")]).status, "accepted");
  assert.equal(read([start(), continued(), resolved("stop")]).status, "stopped");
});

test("accept after stop cannot resurrect the goal", () => {
  const state = read([start(), resolved("stop"), resolved("accept")]);
  assert.equal(state.status, "accepted", "the newest decision wins");
});

test("the budget exhaustion marker survives a newer report-less history", () => {
  const state = read([start(), continued(), exhausted()]);
  assert.equal(state.status, "budget_exhausted");
  assert.equal(state.continuations, 1);
});

test("extend adds turns to the same goal without resetting progress", () => {
  const state = read([start(), continued(), exhausted(), resolved("extend", { extra: EXTEND_STEP })]);
  assert.equal(state.status, "working");
  assert.equal(state.continuations, 1);
  assert.equal(state.maxContinuations, DEFAULT_MAX_CONTINUATIONS + EXTEND_STEP);
  const twice = read([start(), resolved("extend"), resolved("extend")]);
  assert.equal(twice.maxContinuations, DEFAULT_MAX_CONTINUATIONS + EXTEND_STEP * 2);
  assert.equal(twice.continuations, 0, "extensions are not continuations");
});

test("a newer start replaces the previous goal entirely", () => {
  const state = read([
    start(),
    continued(),
    continued(),
    resolved("stop"),
    start({ goal: "Second goal", criteria: [] }),
  ]);
  assert.equal(state.goal, "Second goal");
  assert.deepEqual(state.criteria, []);
  assert.equal(state.status, "working");
  assert.equal(state.continuations, 0);
});

test("malformed starts are ignored instead of showing an empty goal", () => {
  assert.equal(read([custom({ kind: "start", goal: "   " })]), null);
  assert.equal(read([custom({ kind: "start" })]), null);
});

test("the prompt section keeps the goal and rules in front of the model", () => {
  const working = read([start()]);
  const section = goalPromptSection(working);
  assert.match(section, /Goal: Ship the fixture/);
  assert.match(section, /- tests pass/);
  assert.match(section, /goal_report/);
  assert.match(section, /never mark a criterion met without evidence/i);
  const noCriteria = goalPromptSection(read([start({ criteria: [] })]));
  assert.match(noCriteria, /define concrete, user-verifiable criteria/);
  assert.equal(goalPromptSection(read([start(), resolved("accept")])), null);
  assert.equal(goalPromptSection(read([start(), resolved("stop")])), null);
});

test("syncGoalPromptSection derives the state and updates the policy", () => {
  const sections = [];
  const policy = { setGoalSection: (section) => sections.push(section) };
  const state = syncGoalPromptSection(policy, { getBranch: () => [start(), continued()] });
  assert.equal(state.status, "working");
  assert.match(sections.at(-1), /Goal: Ship the fixture/);
  syncGoalPromptSection(policy, { getBranch: () => [start(), resolved("accept")] });
  assert.equal(sections.at(-1), null);
  syncGoalPromptSection(policy, { getBranch: () => [] });
  assert.equal(sections.at(-1), null);
});
