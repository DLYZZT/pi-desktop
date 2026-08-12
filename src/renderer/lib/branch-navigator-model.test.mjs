import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  MAX_BRANCH_GUIDE_DEPTH,
  buildActivePath,
  flattenBranchTree,
  shouldDismissBranchNavigator,
  treeHasBranch,
} from "./branch-navigator-model.ts";

function node(id, children = [], compressedEntryIds) {
  return { entry: { id, type: "message", preview: id }, children, compressedEntryIds };
}

test("deep linear trees are traversed and compressed without recursion", () => {
  let root = node("n-19999");
  for (let index = 19998; index >= 0; index -= 1) root = node(`n-${index}`, [root]);

  const path = buildActivePath([root], "n-19999");
  const rows = flattenBranchTree([root]);

  assert.equal(path.size, 20_000);
  assert.equal(path.has("n-0"), true);
  assert.equal(path.has("n-19999"), true);
  assert.equal(treeHasBranch([root]), false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].representative.entry.id, "n-19999");
  assert.equal(rows[0].skipped, 19_999);
});

test("branch rows are iterative and keep guide work bounded at extreme depth", () => {
  let root = node("trunk-5000");
  for (let depth = 4999; depth >= 0; depth -= 1) {
    root = node(`trunk-${depth}`, [node(`side-${depth}`), root]);
  }

  const rows = flattenBranchTree([root]);

  assert.equal(treeHasBranch([root]), true);
  assert.equal(rows.length, 10_001);
  assert.equal(Math.max(...rows.map((row) => row.depth)), 5_000);
  assert.equal(Math.max(...rows.map((row) => row.guideLines.length)), MAX_BRANCH_GUIDE_DEPTH);
});

test("active path resolves server-compressed ids", () => {
  const target = node("visible", [], ["compressed-target"]);
  const root = node("root", [target]);

  assert.deepEqual([...buildActivePath([root], "compressed-target")], ["visible", "root"]);
});

test("Escape and pointer presses outside dismiss inline navigation", () => {
  const inside = {};
  const outside = {};
  const root = { contains: (target) => target === inside };

  assert.equal(shouldDismissBranchNavigator({ type: "keydown", key: "Escape", target: null }, root), true);
  assert.equal(shouldDismissBranchNavigator({ type: "keydown", key: "Enter", target: null }, root), false);
  assert.equal(shouldDismissBranchNavigator({ type: "pointerdown", target: inside }, root), false);
  assert.equal(shouldDismissBranchNavigator({ type: "pointerdown", target: outside }, root), true);
});

test("BranchNavigator installs and removes both inline dismiss listeners", () => {
  const source = fs.readFileSync(new URL("../components/BranchNavigator.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /<TreeNodeView/);
  assert.match(source, /document\.addEventListener\("keydown", handleDismiss\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handleDismiss, true\)/);
  assert.match(source, /document\.removeEventListener\("keydown", handleDismiss\)/);
  assert.match(source, /document\.removeEventListener\("pointerdown", handleDismiss, true\)/);
});
