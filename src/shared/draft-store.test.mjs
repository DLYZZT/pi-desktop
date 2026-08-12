import assert from "node:assert/strict";
import test from "node:test";

import {
  DraftPersistenceController,
  clearDraft,
  decodedBase64ByteLength,
  flushDraft,
  getDraft,
  persistableDraftImages,
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
  assert.deepEqual(persistableDraftImages([{ data: "A".repeat(3_000_000), mimeType: "image/png" }]), []);
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
