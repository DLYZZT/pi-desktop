import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { SessionListStore } from "./session-list-store.ts";

const session = (id, name = id) => ({
  id,
  name,
  cwd: "/project",
  projectRoot: "/project",
  path: `/${id}`,
  created: "2026-09-26",
  modified: "2026-09-26",
  messageCount: 1,
  firstMessage: id,
});
function fixture(t) {
  const requests = [];
  const store = new SessionListStore(() => {
    const request = createDeferred();
    requests.push(request);
    return request.promise;
  });
  const stop = store.activate();
  t.after(stop);
  return { store, requests, stop };
}

test("sidebar refresh and metadata hydration share one list request and then reuse indexed metadata", async (t) => {
  const { store, requests } = fixture(t);
  const refresh = store.refresh(true);
  const same = store.refresh();
  const metadata = store.findSession("one");
  assert.equal(refresh, same);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  requests[0].resolve({ sessions: [session("one")], runningSessionIds: ["one"] });
  await refresh;
  assert.deepEqual(await metadata, session("one"));
  assert.deepEqual(await store.findSession("one"), session("one"));
  assert.equal(requests.length, 1);
  assert.deepEqual(store.getSnapshot().runningSessionIds, ["one"]);
  assert.equal(store.getSnapshot().loading, false);
});

test("incremental rename and deletion cannot be overwritten by a list response started before them", async (t) => {
  const { store, requests } = fixture(t);
  const deleted = [];
  store.subscribeDeleted((id) => deleted.push(id));
  const refresh = store.refresh();
  await Promise.resolve();
  store.applyChange({ cwd: "/project", session: session("one", "Renamed") });
  store.applyChange({ cwd: "/project", sessionId: "two", deleted: true });
  store.applyChange({ cwd: "/project", sessionId: "two", deleted: true });
  requests[0].resolve({ sessions: [session("one", "Old title"), session("two")] });
  await refresh;
  assert.deepEqual(store.getSnapshot().sessions, [session("one", "Renamed")]);
  assert.deepEqual(deleted, ["two"]);
  assert.equal(requests.length, 1);
  store.applyChange({ cwd: "/project", session: session("two", "Restored") });
  store.applyChange({ cwd: "/project", sessionId: "two", deleted: true });
  assert.deepEqual(deleted, ["two", "two"]);
});

test("multiple ambiguous events during a read cause one trailing read and never publish its obsolete response", async (t) => {
  const { store, requests } = fixture(t);
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot().sessions.map((item) => item.id)));
  const refresh = store.refresh();
  await Promise.resolve();
  store.applyChange({ cwd: null, fullRefresh: true });
  store.applyChange({ cwd: null, sessionId: "unknown" });
  store.invalidate();
  assert.equal(requests.length, 1);
  requests[0].resolve({ sessions: [session("obsolete")] });
  await Promise.resolve();
  assert.equal(requests.length, 2);
  store.applyChange({ cwd: "/project", session: session("one", "Updated during reconciliation") });
  requests[1].resolve({ sessions: [session("one")] });
  await refresh;
  assert.equal(store.getSnapshot().sessions[0].name, "Updated during reconciliation");
  assert.equal(
    observed.some((ids) => ids.includes("obsolete")),
    false,
  );
  assert.equal(requests.length, 2);
});

test("late results and errors from an old mounted lifetime cannot overwrite its replacement", async (t) => {
  const { store, requests, stop } = fixture(t);
  const old = store.refresh();
  await Promise.resolve();
  stop();
  const stopCurrent = store.activate();
  t.after(stopCurrent);
  const current = store.refresh();
  await Promise.resolve();
  requests[1].resolve({ sessions: [session("current")] });
  await current;
  const snapshot = store.getSnapshot();
  requests[0].reject(new Error("old failure"));
  await old;
  assert.equal(store.getSnapshot(), snapshot);
  stop();
  store.applyChange({ cwd: "/project", session: session("next") });
  assert.equal(store.getSnapshot().sessions.length, 2, "old cleanup must not close the replacement owner");
});

test("failed refresh retains indexed sessions, exposes the error, and allows a successful retry", async (t) => {
  const { store, requests } = fixture(t);
  const initial = store.refresh();
  await Promise.resolve();
  requests[0].resolve({ sessions: [session("one")] });
  await initial;
  const failed = store.refresh(true);
  await Promise.resolve();
  const error = new Error("Host unavailable");
  const rejected = assert.rejects(failed, (received) => received === error);
  requests[1].reject(error);
  await rejected;
  assert.equal(store.getSnapshot().error, error);
  assert.equal(store.getSnapshot().loading, false);
  assert.deepEqual(store.getSnapshot().sessions, [session("one")]);
  const retried = store.refresh();
  await Promise.resolve();
  requests[2].resolve({ sessions: [session("two")] });
  await retried;
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(store.getSnapshot().sessions, [session("two")]);
});

test("committed changes use the live stream and retain a refresh fallback when subscription is unavailable", async (t) => {
  const { store, requests } = fixture(t);
  store.setLive(true);
  store.refreshIfDisconnected();
  await Promise.resolve();
  assert.equal(requests.length, 0);
  store.applyChange({ cwd: "/project", session: session("one") });
  assert.deepEqual(await store.findSession("one"), session("one"));
  assert.equal(requests.length, 0);
  store.setLive(false);
  store.refreshIfDisconnected();
  const pending = store.refresh();
  await Promise.resolve();
  requests[0].resolve({ sessions: [session("one")] });
  await pending;
  assert.equal(requests.length, 1);
});

test("snapshots stay stable on no-op notifications and disposed stores cannot start requests", async (t) => {
  const { store, requests, stop } = fixture(t);
  const snapshot = store.getSnapshot();
  let changes = 0;
  const off = store.subscribe(() => changes++);
  store.setLive(false);
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(changes, 0);
  off();
  store.setLive(true);
  assert.equal(changes, 0);
  stop();
  await store.refresh();
  store.invalidate();
  assert.equal(requests.length, 0);
});
