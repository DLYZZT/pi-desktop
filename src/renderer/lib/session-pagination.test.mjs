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

test("unchanged tail messages retain identity while a corrected message is replaced", () => {
  const first = { role: "assistant", content: [{ type: "text", text: "cached markdown" }], usage: { output: 7 } };
  const second = { role: "toolResult", content: [{ type: "text", text: "old result" }], toolCallId: "call" };
  const current = { messages: [first, second], entryIds: ["first", "second"], revision: "same", previousCursor: null };
  const unchanged = { ...page("same", current.entryIds), messages: structuredClone(current.messages) };
  assert.equal(mergeHistoryTail(current, unchanged), current);
  unchanged.messages[1].content[0].text = "corrected result";
  const corrected = mergeHistoryTail(current, unchanged);
  assert.equal(corrected.messages[0], first);
  assert.notEqual(corrected.messages[1], second);
  assert.equal(corrected.messages[1].content[0].text, "corrected result");
  assert.notEqual(mergeHistoryTail(current, unchanged, true).messages[0], first);
});

test("history reuse respects nested tool inputs, removed fields and entry identities", () => {
  const original = { role: "assistant", content: [{ type: "toolCall", input: { value: [1, { text: "before" }] } }] };
  const current = { messages: [original], entryIds: ["one"], revision: "same", previousCursor: null };
  for (const mutate of [
    (value) => {
      value.content[0].input.value[1].text = "after";
    },
    (value) => {
      delete value.content[0].input;
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(mergeHistoryTail(current, { ...page("same", ["one"]), messages: [changed] }).messages[0], changed);
  }
  const differentEntry = { ...page("same", ["two"]), messages: [structuredClone(original)] };
  assert.notEqual(mergeHistoryTail(current, differentEntry).messages[0], original);
});
