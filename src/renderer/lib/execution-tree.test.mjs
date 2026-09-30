import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionTree } from "./execution-tree.ts";

const record = (id, call, parent, status = "succeeded", run = "run") => ({
  executionId: id,
  sequence: 1,
  requestedAt: 1,
  toolCallId: call,
  parentToolCallId: parent,
  runId: run,
  toolName: id,
  status,
});

test("execution trees preserve child outcomes and separate reused call IDs in different turns", () => {
  const parent = record("parent", "one", undefined, "failed"),
    child = record("child", "two", "one"),
    leaf = record("leaf", "three", "two", "interrupted"),
    repeated = record("repeated", "one", undefined, "succeeded", "later");
  const tree = buildExecutionTree([child, leaf, parent, repeated, { ...child, sequence: 2 }]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].record.status, "failed");
  assert.equal(tree[0].children[0].record.status, "succeeded");
  assert.equal(tree[0].children[0].children[0].record.status, "interrupted");
  assert.equal(tree[0].children[0].record.sequence, 2);
  assert.equal(tree[1].children.length, 0);
});

test("missing parents and damaged cyclic relations remain visible without recursive trees", () => {
  const tree = buildExecutionTree([record("a", "a", "b"), record("b", "b", "a"), record("orphan", "c", "missing")]);
  assert.equal(tree.length, 3);
  assert.equal(
    tree.every((node) => node.children.length === 0),
    true,
  );
});
