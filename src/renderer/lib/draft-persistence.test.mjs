import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  DraftPersistenceController,
  MAX_PERSISTED_DRAFT_IMAGE_BYTES,
  flushDraft,
  decodedBase64ByteLength,
  getDraft,
  persistableDraftImages,
  setDraft,
} from "../../shared/draft-store.ts";

function fixture() {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const controller = new DraftPersistenceController(500, {
    stage: (key, draft) => calls.push(["stage", key, draft.value]),
    flush: (key) => calls.push(["flush", key]),
    clear: (key) => calls.push(["clear", key]),
    setTimer(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, callback);
      calls.push(["set-timer", id, delay]);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
      calls.push(["clear-timer", id]);
    },
  });
  return { calls, controller, timers };
}

test("draft writes debounce while memory receives every edit", () => {
  const { calls, controller, timers } = fixture();

  controller.schedule("session", { value: "a", images: [] });
  controller.schedule("session", { value: "ab", images: [] });

  assert.deepEqual(calls.slice(0, 4), [
    ["stage", "session", "a"],
    ["set-timer", 1, 500],
    ["stage", "session", "ab"],
    ["clear-timer", 1],
  ]);
  assert.equal(
    calls.some(([kind]) => kind === "flush"),
    false,
  );
  timers.get(2)();
  assert.deepEqual(calls.at(-1), ["flush", "session"]);
});

test("key switches, explicit commits, clears, and disposal flush pending ownership", () => {
  const { calls, controller } = fixture();

  controller.schedule("old", { value: "old draft", images: [] });
  controller.schedule("new", { value: "new draft", images: [] });
  controller.commit("new", { value: "latest", images: [] });
  controller.schedule("last", { value: "pending", images: [] });
  controller.dispose();
  controller.clear("last");

  assert.deepEqual(
    calls.filter(([kind]) => kind === "flush" || kind === "clear"),
    [
      ["flush", "old"],
      ["flush", "new"],
      ["flush", "last"],
      ["clear", "last"],
    ],
  );
});

test("base64 image limits are checked by decoded bytes before persistence serialization", () => {
  assert.equal(decodedBase64ByteLength("YQ=="), 1);
  assert.equal(decodedBase64ByteLength("YWI="), 2);
  assert.equal(decodedBase64ByteLength("YWJj"), 3);
  assert.equal(persistableDraftImages([{ data: "YQ==", mimeType: "image/png" }]).length, 1);

  const oversized = "A".repeat(Math.ceil(((MAX_PERSISTED_DRAFT_IMAGE_BYTES + 1) * 4) / 3));
  assert.deepEqual(persistableDraftImages([{ data: oversized, mimeType: "image/png" }]), []);
});

test("staging a draft performs no synchronous localStorage write until flush", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const writes = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: (key) => writes.push(["remove", key]),
      setItem: (key, value) => writes.push(["set", key, value]),
    },
  });

  try {
    setDraft("debounce-proof", { value: "draft", images: [] });
    assert.deepEqual(writes, []);
    flushDraft("debounce-proof");
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "set");
    assert.deepEqual(JSON.parse(writes[0][2]), { value: "draft", images: [] });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("an in-memory empty draft hides stale persisted content before debounce flush", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify({ value: "stale", images: [] }),
      removeItem: () => {},
      setItem: () => {},
    },
  });

  try {
    setDraft("empty-tombstone", { value: "", images: [] });
    assert.equal(getDraft("empty-tombstone"), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("ChatInput schedules edits and commits exact refs on key switch and unmount", () => {
  const source = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /draftPersistenceRef\.current\?\.schedule\(draftKey/);
  assert.match(source, /draftPersistenceRef\.current\?\.commit\(previousDraftKey/);
  assert.match(source, /draftPersistenceRef\.current\?\.commit\(currentDraftKey/);
  assert.match(source, /draftPersistenceRef\.current\?\.clear\(draftKey\)/);
  assert.match(source, /commitCurrentDraft\(\);\s*clearInput\(\)/);
});
