import assert from "node:assert/strict";
import test from "node:test";
import { getFleetPresentation, getFleetTriggerSpacing } from "./fleet-presentation.ts";

test("a stale Fleet remains visible but cannot open a terminal", () => {
  const stale = {
    sourceGeneration: 1,
    revision: 2,
    receivedAt: 3,
    stale: true,
    workspaces: [{ id: "w1", tabs: [] }],
    panes: [],
  };
  assert.deepEqual(getFleetPresentation(false, stale), {
    hasFleet: true,
    interactive: false,
    showEmpty: false,
  });
  assert.equal(getFleetPresentation(true, { ...stale, stale: false }).interactive, true);
  assert.equal(getFleetPresentation(true, { ...stale, stale: false, workspaces: [] }).showEmpty, true);
});

test("the initial Fleet trigger aligns right without overlapping the fixed panel toggle", () => {
  assert.deepEqual(getFleetTriggerSpacing(true, 44), { marginLeft: "auto", marginRight: 44 });
  assert.deepEqual(getFleetTriggerSpacing(false, 44), { marginLeft: 10, marginRight: 0 });
  assert.deepEqual(getFleetTriggerSpacing(true, -1), { marginLeft: "auto", marginRight: 0 });
});
