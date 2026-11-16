import assert from "node:assert/strict";
import test from "node:test";
import { createTodoWriteTool, formatTodoList } from "./todo-tool.ts";
import { MAX_TODO_ITEMS } from "./todo-plan.ts";

const items = [
  { content: "Read the projection", status: "completed" },
  { content: "Add the tool", status: "in_progress" },
  { content: "Render the panel", status: "pending" },
];

function execute(todos) {
  return createTodoWriteTool().execute("call-1", { todos }, undefined, undefined, { hasUI: true, ui: {} });
}

test("declares a sequential tool that writes the whole list", () => {
  const tool = createTodoWriteTool();
  assert.equal(tool.name, "todo_write");
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /complete list/);
  assert.equal(tool.parameters.properties.todos.maxItems, MAX_TODO_ITEMS);
});

test("returns the plan in details so the host can project it later", async () => {
  const result = await execute(items);
  assert.deepEqual(result.details, { todos: items });
  assert.equal(
    result.content[0].text,
    ["Plan (1/3 completed):", "- [x] Read the projection", "- [~] Add the tool", "- [ ] Render the panel"].join("\n"),
  );
});

test("an empty list clears the plan", async () => {
  const result = await execute([]);
  assert.deepEqual(result.details, { todos: [] });
  assert.equal(result.content[0].text, "Plan cleared.");
});

test("rejects invalid items before the model sees a broken panel", async () => {
  await assert.rejects(() => execute([{ content: "", status: "pending" }]), /non-empty/);
  await assert.rejects(() => execute([{ content: "x", status: "done" }]), /status must be/);
  await assert.rejects(() => execute("nope"), /must be an array/);
  await assert.rejects(() => execute(Array.from({ length: MAX_TODO_ITEMS + 1 }, () => items[0])), /at most 20/);
});

test("trims content so the panel never shows padded rows", async () => {
  const result = await execute([{ content: "  Add the tool  ", status: "in_progress" }]);
  assert.deepEqual(result.details.todos, [{ content: "Add the tool", status: "in_progress" }]);
});

test("formats every status distinctly", () => {
  assert.equal(formatTodoList([]), "Plan cleared.");
  assert.match(formatTodoList([{ content: "a", status: "completed" }]), /- \[x\] a/);
  assert.match(formatTodoList([{ content: "b", status: "in_progress" }]), /- \[~\] b/);
  assert.match(formatTodoList([{ content: "c", status: "pending" }]), /- \[ \] c/);
});
