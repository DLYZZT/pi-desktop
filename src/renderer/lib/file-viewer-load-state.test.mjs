import assert from "node:assert/strict";
import test from "node:test";

import { INITIAL_TEXT_FILE_LOAD_STATE, textFileLoadReducer } from "./file-viewer-load-state.ts";

const first = { content: "first", language: "text", size: 5 };
const second = { content: "second", language: "text", size: 6 };

test("a successful load structurally clears an earlier error", () => {
  const failed = textFileLoadReducer(INITIAL_TEXT_FILE_LOAD_STATE, { type: "failed", error: "missing" });
  assert.deepEqual(failed, {
    status: "error",
    data: null,
    error: "missing",
    prevContent: null,
    changeCount: 0,
  });

  const recovered = textFileLoadReducer(failed, { type: "succeeded", data: first, refresh: true });
  assert.deepEqual(recovered, {
    status: "ready",
    data: first,
    error: null,
    prevContent: null,
    changeCount: 1,
  });
});

test("a refresh keeps the prior content as the diff baseline", () => {
  const loaded = textFileLoadReducer(INITIAL_TEXT_FILE_LOAD_STATE, {
    type: "succeeded",
    data: first,
    refresh: false,
  });
  const refreshed = textFileLoadReducer(loaded, { type: "succeeded", data: second, refresh: true });

  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.prevContent, first.content);
  assert.equal(refreshed.data, second);
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.changeCount, 1);
});

test("reset removes every prior terminal state", () => {
  const loaded = textFileLoadReducer(INITIAL_TEXT_FILE_LOAD_STATE, {
    type: "succeeded",
    data: first,
    refresh: false,
  });
  assert.equal(textFileLoadReducer(loaded, { type: "reset" }), INITIAL_TEXT_FILE_LOAD_STATE);
});
