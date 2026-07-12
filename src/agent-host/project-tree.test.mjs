import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PROJECTED_TREE_DEPTH, projectTreeForResponse } from "./project-tree.ts";

const node = (id, children = [], extra = {}) => ({ entry: { id }, children, ...extra });

test("compresses linear descendants in source order while preserving the root", () => {
  const leaf = node("leaf");
  const middleB = node("middle-b", [leaf]);
  const middleA = node("middle-a", [middleB]);
  const root = node("root", [middleA]);

  const projected = projectTreeForResponse([root]);

  assert.equal(projected[0].entry.id, "root");
  assert.equal(projected[0].children[0].entry.id, "leaf");
  assert.deepEqual(projected[0].children[0].compressedEntryIds, ["middle-a", "middle-b"]);
});

test("preserves branch points, leaves, and multiple roots", () => {
  const branch = node("branch", [node("left"), node("right")]);
  const roots = [node("root-a", [branch]), node("root-b")];

  const projected = projectTreeForResponse(roots);

  assert.deepEqual(
    projected.map((item) => item.entry.id),
    ["root-a", "root-b"],
  );
  assert.equal(projected[0].children[0].entry.id, "branch");
  assert.deepEqual(
    projected[0].children[0].children.map((item) => item.entry.id),
    ["left", "right"],
  );
});

test("does not mutate input or retain stale compressed ids", () => {
  const leaf = node("leaf", [], { compressedEntryIds: ["stale"] });
  const root = node("root", [leaf], { compressedEntryIds: ["root-stale"] });
  const before = structuredClone(root);

  const projected = projectTreeForResponse([root]);

  assert.deepEqual(root, before);
  assert.equal("compressedEntryIds" in projected[0], false);
  assert.equal("compressedEntryIds" in projected[0].children[0], false);
  assert.notEqual(projected[0], root);
  assert.notEqual(projected[0].children, root.children);
});

test("rejects cycles and shared node objects", () => {
  const cycle = node("cycle");
  cycle.children.push(cycle);
  assert.throws(() => projectTreeForResponse([cycle]), /cycle or shared node/);

  const shared = node("shared");
  assert.throws(
    () => projectTreeForResponse([node("root", [node("left", [shared]), node("right", [shared])])]),
    /cycle or shared node/,
  );
});

test("bounds projected depth without recursive stack usage", () => {
  let current = node(`level-${MAX_PROJECTED_TREE_DEPTH + 20}`);
  for (let index = MAX_PROJECTED_TREE_DEPTH + 19; index >= 0; index -= 1) {
    // Add a sibling at each level so the chain cannot be compressed away.
    current = node(`level-${index}`, [current, node(`sibling-${index}`)]);
  }

  const [projected] = projectTreeForResponse([current]);
  let depth = 1;
  let cursor = projected;
  while (cursor.children.length > 0) {
    cursor = cursor.children[0];
    depth += 1;
  }

  assert.equal(depth, MAX_PROJECTED_TREE_DEPTH + 1);
});
