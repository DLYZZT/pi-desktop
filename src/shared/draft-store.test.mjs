import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DRAFT_SCHEMA_VERSION,
  DraftPersistenceController,
  MAX_PERSISTED_DRAFT_FILES,
  MAX_PERSISTED_DRAFT_IMAGE_BYTES,
  clearDraft,
  decodedBase64ByteLength,
  flushDraft,
  getDraft,
  persistableDraftFiles,
  persistableDraftImages,
  selectDraftImageAdditions,
  setDraft,
} from "./draft-store.ts";

test("draft storage clones values, writes only on flush, and removes empty drafts", (t) => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });

  const key = `owner-${Date.now()}`;
  const draft = { value: "hello", images: [{ data: "YQ==", mimeType: "image/png" }] };
  setDraft(key, draft);
  draft.value = "mutated";
  assert.equal(getDraft(key).value, "hello");
  assert.equal(values.size, 0);
  flushDraft(key);
  assert.equal(JSON.parse(values.values().next().value).value, "hello");
  clearDraft(key);
  assert.equal(values.size, 0);
});

test("base64 size accounting excludes oversized image sets before serialization", () => {
  assert.equal(decodedBase64ByteLength("YQ=="), 1);
  assert.equal(decodedBase64ByteLength("YWI="), 2);
  assert.deepEqual(persistableDraftImages([{ data: "YQ==", mimeType: "image/png" }]).length, 1);
  const oversized = "A".repeat(Math.ceil(((MAX_PERSISTED_DRAFT_IMAGE_BYTES + 1) * 4) / 3));
  assert.deepEqual(persistableDraftImages([{ data: oversized, mimeType: "image/png" }]), []);
});

test("image additions are rejected with distinct count and byte-limit reasons", () => {
  const tiny = (name) => ({ name, data: "YQ==", mimeType: "image/png" });
  const countSelection = selectDraftImageAdditions(
    [tiny("one"), tiny("two"), tiny("three"), tiny("four")],
    [tiny("five")],
  );
  assert.deepEqual(countSelection.accepted, []);
  assert.equal(countSelection.rejected[0].reason, "count");

  const oversized = "A".repeat(Math.ceil(((MAX_PERSISTED_DRAFT_IMAGE_BYTES + 1) * 4) / 3));
  const byteSelection = selectDraftImageAdditions([], [{ data: oversized, mimeType: "image/png" }, tiny("small")]);
  assert.deepEqual(byteSelection.accepted, [tiny("small")]);
  assert.equal(byteSelection.rejected[0].reason, "bytes");
});

test("draft files require absolute paths, are deduplicated, and share the persisted limit", () => {
  const files = [
    { name: "one", path: "/tmp/one.txt" },
    { name: "duplicate", path: "/tmp/one.txt" },
    { name: "relative", path: "tmp/two.txt" },
    ...Array.from({ length: MAX_PERSISTED_DRAFT_FILES + 2 }, (_, index) => ({
      name: `file-${index}`,
      path: `C:\\work\\file-${index}.txt`,
    })),
  ];
  const persisted = persistableDraftFiles(files);
  assert.equal(persisted.length, MAX_PERSISTED_DRAFT_FILES);
  assert.equal(persisted[0].path, "/tmp/one.txt");
  assert.equal(
    persisted.some((file) => file.path === "tmp/two.txt"),
    false,
  );
});

test("loads legacy drafts, rejects future schemas, and validates restored fields", (t) => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });

  const legacyKey = `pi-desktop-draft:legacy-${Date.now()}`;
  values.set(
    legacyKey,
    JSON.stringify({
      value: "legacy",
      images: [
        { data: "YQ==", mimeType: "image/png" },
        { data: "bad", mimeType: "text/plain" },
      ],
      files: [
        { name: "ok", path: "/tmp/ok.txt" },
        { name: "bad", path: "relative.txt" },
      ],
    }),
  );
  assert.deepEqual(getDraft(legacyKey.slice("pi-desktop-draft:".length)), {
    value: "legacy",
    images: [{ data: "YQ==", mimeType: "image/png" }],
    files: [{ name: "ok", path: "/tmp/ok.txt" }],
  });

  const futureKey = `pi-desktop-draft:future-${Date.now()}`;
  values.set(futureKey, JSON.stringify({ schemaVersion: CHAT_DRAFT_SCHEMA_VERSION + 1, value: "future", images: [] }));
  assert.equal(getDraft(futureKey.slice("pi-desktop-draft:".length)), null);
});

test("draft controller flushes ownership on key changes and disposal", () => {
  const events = [];
  let scheduled;
  const controller = new DraftPersistenceController(500, {
    stage: (key) => events.push(`stage:${key}`),
    flush: (key) => events.push(`flush:${key}`),
    clear: (key) => events.push(`clear:${key}`),
    setTimer: (callback) => {
      scheduled = callback;
      return 1;
    },
    clearTimer: () => events.push("cancel"),
  });
  controller.schedule("one", { value: "1", images: [] });
  controller.schedule("two", { value: "2", images: [] });
  scheduled();
  controller.dispose();
  assert.deepEqual(events, ["stage:one", "cancel", "flush:one", "stage:two", "flush:two"]);
});

test("draft controller reports persistence failures", () => {
  const errors = [];
  const controller = new DraftPersistenceController(
    500,
    {
      stage: () => {},
      flush: () => false,
      clear: () => false,
      setTimer: () => 1,
      clearTimer: () => {},
    },
    (key) => errors.push(key),
  );
  assert.equal(controller.commit("one", { value: "draft", images: [], files: [] }), false);
  assert.equal(controller.clear("two"), false);
  assert.deepEqual(errors, ["one", "two"]);
});
