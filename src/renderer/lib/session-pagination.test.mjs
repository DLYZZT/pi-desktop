import assert from "node:assert/strict";
import test from "node:test";
import { mergeHistoryTail, prependHistoryPage } from "./session-pagination.ts";

const message = (text) => ({ role: "user", content: text });
const page = (revision, ids, cursor) => ({
  messages: ids.map(message),
  entryIds: ids,
  thinkingLevel: "off",
  model: null,
  totalMessages: ids.length,
  loadedMessages: ids.length,
  truncatedBefore: Boolean(cursor),
  previousCursor: cursor,
  historyRevision: revision,
});

test("tail refresh preserves loaded older pages and replaces overlapping tail entries", () => {
  const current = {
    messages: [message("old"), message("tail-old")],
    entryIds: ["old", "tail"],
    revision: "same",
    previousCursor: "older-cursor",
  };
  const merged = mergeHistoryTail(current, page("same", ["tail", "new"]));
  assert.deepEqual(merged.entryIds, ["old", "tail", "new"]);
  assert.deepEqual(
    merged.messages.map((item) => item.content),
    ["old", "tail", "new"],
  );
  assert.equal(merged.previousCursor, "older-cursor");
});

test("revision changes and non-overlapping tails reset pagination", () => {
  const current = {
    messages: [message("old")],
    entryIds: ["old"],
    revision: "old-revision",
    previousCursor: null,
  };
  assert.deepEqual(mergeHistoryTail(current, page("new-revision", ["new"], "cursor")).entryIds, ["new"]);
  assert.deepEqual(mergeHistoryTail({ ...current, revision: "same" }, page("same", ["new"])).entryIds, ["new"]);
});

test("prepend deduplicates entries and rejects stale revisions", () => {
  const current = {
    messages: [message("two"), message("three")],
    entryIds: ["two", "three"],
    revision: "same",
    previousCursor: "current",
  };
  const prepended = prependHistoryPage(current, page("same", ["one", "two"], "older"));
  assert.deepEqual(prepended.entryIds, ["one", "two", "three"]);
  assert.equal(prepended.previousCursor, "older");
  assert.equal(prependHistoryPage(current, page("stale", ["one"])), null);
});
