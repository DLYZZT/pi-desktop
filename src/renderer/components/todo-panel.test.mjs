import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";

const { TodoPanel } = await importTestBundle("todo-panel-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export { TodoPanel } from "./TodoPanel.tsx";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [inlinePortalPlugin],
});

const items = [
  { content: "Read the projection", status: "completed" },
  { content: "Add the todo tool", status: "in_progress" },
  { content: "Render the panel", status: "pending" },
];

const plan = { items, completed: 1 };

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

async function mountPanel(component, props) {
  let renderer;
  await act(async () => {
    renderer = create(createElement(component, props), { createNodeMock: () => ({ focus() {}, style: {} }) });
  });
  return renderer;
}

test("shows the progress header and every item", async (t) => {
  const dom = installDomTestEnvironment();
  const renderer = await mountPanel(TodoPanel, { plan });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  const rendered = text(renderer);
  assert.match(rendered, /Plan 1\/3/);
  for (const item of items) assert.ok(rendered.includes(item.content), item.content);
  // Completed items are dimmed; the others keep the full text colour.
  const dimmed = renderer.root.findAll(
    (node) => typeof node.type === "string" && node.props.style?.color === "var(--text-dim)",
  );
  assert.equal(dimmed.length, 1);
  assert.equal(flatten(dimmed[0].props.children), "Read the projection");
});

test("the header toggles expansion and remembers a manual collapse", async (t) => {
  const dom = installDomTestEnvironment();
  const renderer = await mountPanel(TodoPanel, { plan });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  const toggle = () => renderer.root.findByProps({ "aria-expanded": true });

  assert.equal(toggle().props["aria-expanded"], true);
  await act(async () => toggle().props.onClick());
  // Collapsed: only the current step survives as a summary line.
  const collapsed = text(renderer);
  assert.match(collapsed, /Plan 1\/3/);
  assert.match(collapsed, /Add the todo tool/);
  assert.equal(collapsed.includes("Render the panel"), false);
  assert.equal(renderer.root.findAll((node) => node.type === "ol").length, 0);

  await act(async () => renderer.root.findByProps({ "aria-expanded": false }).props.onClick());
  assert.equal(text(renderer).includes("Render the panel"), true);
});

test("a finished plan starts collapsed and stays that way after new items arrive", async (t) => {
  const dom = installDomTestEnvironment();
  const done = { items: items.map((item) => ({ ...item, status: "completed" })), completed: 3 };
  const renderer = await mountPanel(TodoPanel, { plan: done });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  assert.equal(renderer.root.findAll((node) => node.type === "ol").length, 0);
  assert.match(text(renderer), /Plan 3\/3/);

  // The user never collapsed it, so a plan that is no longer finished expands again.
  await act(async () => {
    renderer.update(createElement(TodoPanel, { plan }));
  });
  assert.equal(renderer.root.findAll((node) => node.type === "ol").length, 1);
});

test("dismiss is offered and reports upward", async (t) => {
  const dom = installDomTestEnvironment();
  const dismissed = [];
  const renderer = await mountPanel(TodoPanel, { plan, onDismiss: () => dismissed.push(true) });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  const close = renderer.root.findByProps({ "aria-label": "Hide until the plan changes" });
  await act(async () => close.props.onClick());
  assert.deepEqual(dismissed, [true]);

  const withoutDismiss = await mountPanel(TodoPanel, { plan });
  assert.equal(
    withoutDismiss.root.findAll((node) => node.props["aria-label"] === "Hide until the plan changes").length,
    0,
  );
  await act(async () => withoutDismiss.unmount());
});
