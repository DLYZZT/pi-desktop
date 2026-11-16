import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { readTodoPlan, readTodoItems, summarizeTodoItems, MAX_TODO_ITEMS, TODO_WRITE_TOOL_NAME } =
  await importTestBundle("todo-plan", {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: 'export * from "./todo-plan.ts";',
    },
  });

const items = [
  { content: "Read the session projection", status: "completed" },
  { content: "Add the todo tool", status: "in_progress" },
  { content: "Render the panel", status: "pending" },
];

function toolResult(todos, extra = {}) {
  return {
    id: `e-${Math.random()}`,
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: TODO_WRITE_TOOL_NAME,
      content: [],
      details: { todos },
      ...extra,
    },
  };
}

test("reads items, rejecting anything the tool cannot render", () => {
  assert.deepEqual(readTodoItems(items), items);
  assert.throws(() => readTodoItems("nope"), /must be an array/);
  assert.throws(() => readTodoItems([{ content: "  ", status: "pending" }]), /non-empty/);
  assert.throws(() => readTodoItems([{ content: "x", status: "done" }]), /status must be/);
  assert.throws(() => readTodoItems(Array.from({ length: MAX_TODO_ITEMS + 1 }, () => items[0])), /at most 20/);
});

test("an empty write clears the plan, so the panel hides", () => {
  assert.equal(summarizeTodoItems([]), null);
  assert.deepEqual(summarizeTodoItems(items), { items, completed: 1 });
});

test("the newest successful write on the branch wins", () => {
  const path = [toolResult(items), toolResult([{ content: "Only step", status: "pending" }])];
  assert.deepEqual(readTodoPlan(path), {
    items: [{ content: "Only step", status: "pending" }],
    completed: 0,
  });
  assert.equal(readTodoPlan([]), null);
});

test("a later empty write hides the plan instead of restoring an older one", () => {
  assert.equal(readTodoPlan([toolResult(items), toolResult([])]), null);
});

test("failed writes and unrelated tool results do not change the plan", () => {
  const failed = toolResult(items, { isError: true });
  const other = {
    id: "e-other",
    type: "message",
    message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [], details: { todos: items } },
  };
  assert.equal(readTodoPlan([failed]), null);
  assert.equal(readTodoPlan([other]), null);
  // A failed write must not clear an earlier good plan.
  assert.deepEqual(readTodoPlan([toolResult(items), failed]), { items, completed: 1 });
});

test("a branch without writes has no plan, so switching branches follows the branch", () => {
  const branchA = [toolResult(items)];
  assert.deepEqual(readTodoPlan(branchA), { items, completed: 1 });
  assert.equal(readTodoPlan([]), null);
});

test("malformed details are ignored rather than rendering garbage", () => {
  assert.equal(readTodoPlan([toolResult("not a list")]), null);
  assert.equal(readTodoPlan([toolResult([{ content: "x", status: "weird" }])]), null);
});
