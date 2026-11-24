import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";

const { GoalPanel } = await importTestBundle("goal-panel-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export { GoalPanel } from "./GoalPanel.tsx";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [inlinePortalPlugin],
});

const report = {
  summary: "Fixture summary",
  criteria: [
    { criterion: "tests pass", met: true, evidence: "npm test: 120 passing" },
    { criterion: "docs updated", met: false, evidence: "README still missing the section" },
  ],
};

const working = {
  goal: "Ship the fixture",
  criteria: ["tests pass", "docs updated"],
  status: "working",
  continuations: 2,
  maxContinuations: 8,
  checkpointEvery: 4,
  report: null,
  feedback: null,
};

/** Collect text from a react-test-renderer JSON tree (node.children, not props). */
function flatten(children) {
  if (children === null || children === undefined || children === false) return "";
  if (Array.isArray(children)) return children.map(flatten).join("");
  if (typeof children === "object") return flatten(children.children);
  return String(children);
}

function text(renderer) {
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function hostButton(renderer, label) {
  return renderer.root.findAll((node) => node.type === "button" && flatten(node.props.children) === label);
}

async function mountPanel(t, props) {
  const dom = installDomTestEnvironment();
  let renderer;
  await act(async () => {
    renderer = create(createElement(GoalPanel, props), { createNodeMock: () => ({ focus() {}, style: {} }) });
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  return renderer;
}

test("a working goal shows its status, budget, criteria and stop action", async (t) => {
  const actions = [];
  const renderer = await mountPanel(t, {
    state: working,
    onAction: (action, feedback) => actions.push({ action, feedback }),
  });
  const rendered = text(renderer);
  assert.match(rendered, /Ship the fixture/);
  assert.match(rendered, /In progress/);
  assert.match(rendered, /2\/8 auto-continues/);
  assert.match(rendered, /Acceptance criteria/);
  assert.match(rendered, /tests pass/);
  assert.equal(hostButton(renderer, "Accept").length, 0);

  await act(async () => hostButton(renderer, "Stop goal")[0].props.onClick());
  assert.deepEqual(actions, [{ action: "stop", feedback: undefined }]);
});

test("the report lists evidence and only a user click accepts", async (t) => {
  const actions = [];
  const state = { ...working, status: "awaiting_acceptance", report };
  const renderer = await mountPanel(t, {
    state,
    onAction: (action, feedback) => actions.push({ action, feedback }),
  });
  const rendered = text(renderer);
  assert.match(rendered, /Ready for review/);
  assert.match(rendered, /Fixture summary/);
  assert.match(rendered, /npm test: 120 passing/);
  assert.match(rendered, /README still missing the section/);

  await act(async () => hostButton(renderer, "Accept")[0].props.onClick());
  assert.deepEqual(actions, [{ action: "accept", feedback: undefined }]);
});

test("send back collects feedback before asking the host to resume", async (t) => {
  const actions = [];
  const state = { ...working, status: "awaiting_acceptance", report };
  const renderer = await mountPanel(t, {
    state,
    onAction: (action, feedback) => actions.push({ action, feedback }),
  });

  const toggle = hostButton(renderer, "Send back")[0];
  assert.equal(toggle.props["aria-expanded"], false);
  await act(async () => toggle.props.onClick());
  assert.equal(hostButton(renderer, "Send back")[0].props["aria-expanded"], true);

  const textarea = renderer.root.findAll((node) => node.type === "textarea")[0];
  assert.ok(textarea, "the feedback form must open");
  await act(async () => textarea.props.onChange({ target: { value: "  finish the docs  " } }));

  await act(async () => hostButton(renderer, "Confirm send back")[0].props.onClick());
  assert.deepEqual(actions, [{ action: "reject", feedback: "  finish the docs  " }]);
});

test("an exhausted budget offers more turns, acceptance and stop", async (t) => {
  const actions = [];
  const renderer = await mountPanel(t, {
    state: { ...working, status: "budget_exhausted", continuations: 8 },
    onAction: (action) => actions.push(action),
  });
  const rendered = text(renderer);
  assert.match(rendered, /Budget exhausted/);
  assert.match(rendered, /8\/8 auto-continues/);

  await act(async () => hostButton(renderer, "Add budget")[0].props.onClick());
  await act(async () => hostButton(renderer, "Accept")[0].props.onClick());
  await act(async () => hostButton(renderer, "Stop goal")[0].props.onClick());
  assert.deepEqual(actions, ["extend", "accept", "stop"]);
});

test("a decided goal starts collapsed and can still be expanded or dismissed", async (t) => {
  const dismissed = [];
  const accepted = { ...working, status: "accepted", continuations: 3 };
  const renderer = await mountPanel(t, {
    state: accepted,
    onAction: () => {},
    onDismiss: () => dismissed.push(true),
  });
  assert.equal(renderer.root.findAll((node) => node.type === "ol").length, 0);
  assert.match(text(renderer), /Accepted/);
  assert.match(text(renderer), /Ship the fixture/);

  await act(async () => renderer.root.findByProps({ "aria-expanded": false }).props.onClick());
  assert.equal(renderer.root.findAll((node) => node.type === "ol").length, 0, "a decided goal has no report to show");
  assert.match(text(renderer), /3\/8 auto-continues/);

  await act(async () => renderer.root.findByProps({ "aria-label": "Hide until the goal changes" }).props.onClick());
  assert.deepEqual(dismissed, [true]);
});

test("a rejected goal shows the last feedback while it works", async (t) => {
  const renderer = await mountPanel(t, {
    state: { ...working, feedback: "docs are still missing" },
    onAction: () => {},
  });
  assert.match(text(renderer), /docs are still missing/);
});
