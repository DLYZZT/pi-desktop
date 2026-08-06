import assert from "node:assert/strict";
import test from "node:test";
import { applySessionChangedEvent } from "./session-sidebar-state.ts";

const session = (id, modified, parentSessionId) => ({
  id,
  path: `/${id}`,
  cwd: "/project",
  created: modified,
  modified,
  messageCount: 1,
  firstMessage: id,
  parentSessionId,
});

test("upserts and sorts individual session changes", () => {
  const initial = [session("old", "2026-08-01T00:00:00.000Z")];
  const next = applySessionChangedEvent(initial, {
    cwd: "/project",
    session: session("new", "2026-08-02T00:00:00.000Z", "old"),
  });
  assert.deepEqual(
    next.map((item) => item.id),
    ["new", "old"],
  );
  const updated = applySessionChangedEvent(next, {
    cwd: "/project",
    session: { ...session("old", "2026-08-03T00:00:00.000Z"), name: "renamed" },
  });
  assert.deepEqual(
    updated.map((item) => item.id),
    ["old", "new"],
  );
  assert.equal(updated[0].name, "renamed");
});

test("deletes one session and requests full refresh for ambiguous events", () => {
  const initial = [session("one", "2026-08-01T00:00:00.000Z"), session("two", "2026-08-02T00:00:00.000Z")];
  assert.deepEqual(
    applySessionChangedEvent(initial, { cwd: null, sessionId: "one", deleted: true }).map((item) => item.id),
    ["two"],
  );
  assert.equal(applySessionChangedEvent(initial, { cwd: null, fullRefresh: true }), null);
  assert.equal(applySessionChangedEvent(initial, { cwd: null, sessionId: "one" }), null);
});
