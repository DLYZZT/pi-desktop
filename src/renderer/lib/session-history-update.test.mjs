import assert from "node:assert/strict";
import test from "node:test";

import { prependHistoryPage } from "./session-pagination.ts";
import {
  appendLocalHistoryMessage,
  removeLastHistoryMessage,
  replaceLastHistoryMessage,
} from "./session-history-update.ts";

test("streamed local messages stay aligned and survive an older-page prepend", () => {
  const old = { role: "user", content: "old" };
  const streamed = { role: "assistant", content: [] };
  const appended = appendLocalHistoryMessage({ messages: [old], entryIds: ["old-id"] }, streamed);
  const prepended = prependHistoryPage(
    { ...appended, revision: "revision", previousCursor: "cursor" },
    {
      messages: [{ role: "user", content: "older" }],
      entryIds: ["older-id"],
      historyRevision: "revision",
    },
  );

  assert.deepEqual(prepended.messages, [{ role: "user", content: "older" }, old, streamed]);
  assert.deepEqual(prepended.entryIds, ["older-id", "old-id", ""]);
});

test("optimistic replacement and rollback update messages and entry ids together", () => {
  const optimistic = appendLocalHistoryMessage(
    { messages: [{ role: "assistant", content: [] }], entryIds: ["assistant-id"] },
    { role: "user", content: "draft" },
  );
  const delivered = replaceLastHistoryMessage(optimistic, { role: "user", content: "delivered" });
  assert.deepEqual(delivered.entryIds, ["assistant-id", ""]);
  assert.equal(delivered.messages.at(-1).content, "delivered");

  assert.deepEqual(removeLastHistoryMessage(delivered), {
    messages: [{ role: "assistant", content: [] }],
    entryIds: ["assistant-id"],
  });
});
