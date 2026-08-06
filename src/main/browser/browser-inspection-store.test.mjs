import assert from "node:assert/strict";
import test from "node:test";

import { BrowserInspectionStore } from "./browser-inspection-store.ts";

test("inspection store returns compact unchanged deltas and rejects cross-session ids", () => {
  let now = 1_000;
  const store = new BrowserInspectionStore(() => now, 1_000, 10);
  const first = store.record({
    sessionId: "session-a",
    tabId: "tab-a",
    generation: 2,
    contentHash: "content",
    viewportHash: "viewport",
  });
  assert.equal(first.changed, true);
  const second = store.record({
    sessionId: "session-a",
    tabId: "tab-a",
    generation: 2,
    contentHash: "content",
    viewportHash: "viewport",
    sinceInspectionId: first.inspectionId,
  });
  assert.equal(second.changed, false);
  assert.throws(
    () =>
      store.record({
        sessionId: "session-b",
        tabId: "tab-a",
        generation: 2,
        contentHash: "content",
        viewportHash: "viewport",
        sinceInspectionId: first.inspectionId,
      }),
    (error) => error.code === "INSPECTION_STALE",
  );

  now += 1_001;
  assert.throws(
    () =>
      store.record({
        sessionId: "session-a",
        tabId: "tab-a",
        generation: 2,
        contentHash: "content",
        viewportHash: "viewport",
        sinceInspectionId: second.inspectionId,
      }),
    (error) => error.code === "INSPECTION_STALE",
  );
});

test("inspection store bounds records and clears tab/session state", () => {
  const store = new BrowserInspectionStore(() => 1_000, 10_000, 2);
  const ids = [];
  for (const [sessionId, tabId] of [
    ["session-a", "tab-a"],
    ["session-a", "tab-b"],
    ["session-b", "tab-c"],
  ]) {
    ids.push(
      store.record({
        sessionId,
        tabId,
        generation: 1,
        contentHash: tabId,
        viewportHash: tabId,
      }).inspectionId,
    );
  }
  assert.equal(store.size(), 2);
  store.clearTab("tab-b");
  assert.equal(store.size(), 1);
  store.clearSession("session-b");
  assert.equal(store.size(), 0);
  assert.equal(ids.length, 3);
});
