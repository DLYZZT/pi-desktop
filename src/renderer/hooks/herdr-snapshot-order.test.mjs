import assert from "node:assert/strict";
import test from "node:test";
import { invalidateHerdrFleetSnapshot, isNewerHerdrSnapshot } from "./herdr-snapshot-order.ts";

test("Herdr snapshots never roll back after a newer stream event", () => {
  const current = { sourceGeneration: 7, revision: 10 };
  assert.equal(isNewerHerdrSnapshot({ sourceGeneration: 6, revision: 99 }, current), false);
  assert.equal(isNewerHerdrSnapshot({ sourceGeneration: 7, revision: 9 }, current), false);
  assert.equal(isNewerHerdrSnapshot({ sourceGeneration: 7, revision: 10 }, current), false);
  assert.equal(isNewerHerdrSnapshot({ sourceGeneration: 7, revision: 11 }, current), true);
  assert.equal(isNewerHerdrSnapshot({ sourceGeneration: 8, revision: 1 }, current), true);
});

test("disabled or unavailable runtime retains the last Fleet snapshot as stale context", () => {
  const current = {
    sourceGeneration: 7,
    revision: 10,
    receivedAt: 1,
    stale: false,
    workspaces: [{ id: "workspace-a", label: "Workspace A", rootPaneId: "pane-a" }],
    panes: [{ id: "pane-a", workspaceId: "workspace-a", tabId: "tab-a", alive: true }],
  };
  const invalidated = invalidateHerdrFleetSnapshot(current);
  assert.equal(invalidated.stale, true);
  assert.deepEqual(invalidated.workspaces, current.workspaces);
  assert.deepEqual(invalidated.panes, current.panes);
  assert.notEqual(invalidated, current);
  assert.equal(invalidated.sourceGeneration, 7);
  assert.equal(invalidated.revision, 10);
  assert.equal(invalidateHerdrFleetSnapshot(null), null);
});
