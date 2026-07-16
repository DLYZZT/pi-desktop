import assert from "node:assert/strict";
import test from "node:test";

import { filterSessionsForQuery, getSessionDisplayTitle, sessionDateGroup } from "./session-list.ts";

function session(id, overrides = {}) {
  return {
    id,
    name: "",
    firstMessage: "",
    cwd: "/workspace/pi-desktop",
    modified: "2026-07-15T12:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

test("groups sessions into calendar-aware recency buckets", () => {
  const now = new Date("2026-07-15T18:00:00.000Z");
  assert.equal(sessionDateGroup("2026-07-15T09:00:00.000Z", now), "today");
  assert.equal(sessionDateGroup("2026-07-10T09:00:00.000Z", now), "recent");
  assert.equal(sessionDateGroup("2026-07-01T09:00:00.000Z", now), "older");
  assert.equal(sessionDateGroup("invalid", now), "older");
});

test("searches useful session metadata and retains matching ancestors", () => {
  const parent = session("parent", { name: "Root session" });
  const child = session("child", {
    parentSessionId: "parent",
    firstMessage: "Investigate keyboard navigation",
    worktreeBranch: "codex/accessibility",
  });
  const unrelated = session("other", { firstMessage: "Unrelated task", cwd: "/workspace/other" });

  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "keyboard").map((item) => item.id),
    ["parent", "child"],
  );
  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "ACCESSIBILITY").map((item) => item.id),
    ["parent", "child"],
  );
  assert.deepEqual(
    filterSessionsForQuery([parent, child, unrelated], "/workspace/other").map((item) => item.id),
    ["other"],
  );
});

test("builds stable compact titles from names, prompts, and ids", () => {
  assert.equal(getSessionDisplayTitle(session("id", { name: "  Named session  " })), "Named session");
  assert.equal(
    getSessionDisplayTitle(session("id", { firstMessage: "Investigate\n  keyboard   navigation" })),
    "Investigate keyboard navigation",
  );
  assert.equal(getSessionDisplayTitle(session("fallback-id")), "fallback-id");
  assert.equal(
    getSessionDisplayTitle(session("id", { firstMessage: "A long title for truncation" }), 12),
    "A long titl…",
  );
});
