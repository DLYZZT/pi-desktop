import assert from "node:assert/strict";
import test from "node:test";
import { SessionPresentationStore } from "./session-presentation-store.ts";

const value = (id, name = id) => ({ sessionId: id, info: { id, name }, stats: null, contextUsage: null });

test("equivalent small snapshots retain identity and do not notify consumers", () => {
  const store = new SessionPresentationStore(),
    owner = store.createPublisher();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  owner.activate();
  owner.update(value("a"));
  const snapshot = store.getSnapshot();
  owner.update({ contextUsage: null, stats: null, info: { name: "a", id: "a" }, sessionId: "a" });
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(updates, 1);
  owner.update(value("a", "renamed"));
  assert.equal(store.getSnapshot().info.name, "renamed");
  assert.equal(updates, 2);
  unsubscribe();
  owner.release();
  assert.equal(updates, 2);
});

test("a replaced chat cannot publish into or clear its successor", () => {
  const store = new SessionPresentationStore();
  const old = store.createPublisher(),
    next = store.createPublisher();
  old.activate();
  old.update(value("a"));
  next.activate();
  next.update(value("b"));
  const current = store.getSnapshot();
  old.update(value("a", "late"));
  old.release();
  assert.equal(store.getSnapshot(), current);
  next.release();
  assert.equal(store.getSnapshot(), null);
  next.update(value("b", "after unmount"));
  assert.equal(store.getSnapshot(), null);
});

test("window stores are independent and new-session promotion retains its publisher", () => {
  const first = new SessionPresentationStore(),
    second = new SessionPresentationStore();
  const publisher = first.createPublisher();
  publisher.activate();
  publisher.update(value(null));
  publisher.update(value("new"));
  assert.equal(first.getSnapshot().sessionId, "new");
  assert.equal(second.getSnapshot(), null);
});
