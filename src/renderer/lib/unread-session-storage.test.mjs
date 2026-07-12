import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_UNREAD_SESSIONS_STORAGE_KEY,
  UNREAD_SESSIONS_STORAGE_KEY,
  loadUnreadSessionIds,
  saveUnreadSessionIds,
} from "./unread-session-storage.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

test("prefers the desktop key and removes a stale legacy key", () => {
  const storage = createStorage({
    [UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["new-session"]),
    [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["old-session"]),
  });

  assert.deepEqual([...loadUnreadSessionIds(storage)], ["new-session"]);
  assert.equal(storage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), null);
});

test("migrates valid legacy data exactly once", () => {
  const storage = createStorage({
    [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["one", 2, "two", "one"]),
  });

  assert.deepEqual([...loadUnreadSessionIds(storage)], ["one", "two"]);
  assert.equal(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY), JSON.stringify(["one", "two"]));
  assert.equal(storage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), null);
  assert.deepEqual([...loadUnreadSessionIds(storage)], ["one", "two"]);
});

test("handles missing and corrupt data without throwing", () => {
  assert.deepEqual([...loadUnreadSessionIds(createStorage())], []);
  const corrupt = createStorage({ [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: "not-json" });
  assert.deepEqual([...loadUnreadSessionIds(corrupt)], []);
  assert.equal(corrupt.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), null);
});

test("writes only the desktop key and removes both keys for an empty set", () => {
  const storage = createStorage({ [LEGACY_UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["old"]) });
  saveUnreadSessionIds(storage, new Set(["new"]));
  assert.equal(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY), JSON.stringify(["new"]));
  assert.equal(storage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY), null);

  saveUnreadSessionIds(storage, new Set());
  assert.equal(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY), null);
});
