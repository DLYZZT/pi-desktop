import assert from "node:assert/strict";
import test from "node:test";

import { NOTICE_VISIBLE_MS, noticeExpiryDelay, noticeReducer } from "./notice-queue.ts";

function notice(id, expiresAt) {
  return { id, message: id, type: "info", expiresAt };
}

test("adding a notice does not extend the oldest notice lifetime", () => {
  const first = notice("first", 5_000);
  let state = noticeReducer({ visible: [], pending: [] }, { type: "add", notice: first });
  state = noticeReducer(state, { type: "add", notice: notice("second", 8_000) });

  assert.equal(state.visible[0], first);
  assert.equal(state.visible[0].expiresAt, 5_000);
  assert.equal(noticeExpiryDelay(state.visible[0], 3_000), 2_000);
  assert.equal(noticeExpiryDelay(state.visible[0], 5_100), 0);
});

test("a pending notice receives its full lifetime when it becomes visible", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < 6; i += 1) {
    state = noticeReducer(state, { type: "add", notice: notice(String(i), 5_000 + i) });
  }

  assert.equal(state.visible[0].exiting, true);
  assert.deepEqual(
    state.pending.map(({ id }) => id),
    ["5"],
  );

  state = noticeReducer(state, { type: "remove", id: "0", now: 10_000 });

  assert.deepEqual(
    state.visible.map(({ id }) => id),
    ["1", "2", "3", "4", "5"],
  );
  assert.equal(state.visible[4].expiresAt, 10_000 + NOTICE_VISIBLE_MS);
});

test("marking a notice as exiting preserves its absolute expiry", () => {
  const state = noticeReducer(
    { visible: [notice("first", 4_321), notice("second", 9_876)], pending: [] },
    { type: "mark_oldest_exiting" },
  );

  assert.equal(state.visible[0].exiting, true);
  assert.equal(state.visible[0].expiresAt, 4_321);
  assert.equal(state.visible[1].expiresAt, 9_876);
});
