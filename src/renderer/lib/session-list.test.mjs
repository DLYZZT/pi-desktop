import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSessionsForQuery,
  getSessionDisplayTitle,
  groupSessionsByProject,
  resolveEmptyProjectRoots,
  resolveInitialSessionRestore,
  sessionDateGroup,
} from "./session-list.ts";

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
  const localDate = (day, hour) => new Date(2026, 6, day, hour).toISOString();
  const now = new Date(2026, 6, 15, 18);
  assert.equal(sessionDateGroup(localDate(15, 9), now), "today");
  assert.equal(sessionDateGroup(localDate(10, 9), now), "recent");
  assert.equal(sessionDateGroup(localDate(1, 9), now), "older");
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

test("initial session restore waits for a successful list result", () => {
  assert.deepEqual(resolveInitialSessionRestore([], "missing", true, false, false), { status: "wait" });
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, true, false), { status: "wait" });
});

test("a successfully loaded empty list completes the not-found restore path", () => {
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, false, false), { status: "not-found" });
  assert.deepEqual(resolveInitialSessionRestore([], "missing", false, false, true), { status: "none" });
});

test("initial session restore returns the matching session", () => {
  const target = session("target");
  assert.deepEqual(resolveInitialSessionRestore([session("other"), target], "target", false, false, false), {
    status: "restore",
    session: target,
  });
});

test("groups sessions by project with worktrees collapsed, most recent project first", () => {
  const older = session("older", { cwd: "/workspace/alpha", modified: "2026-07-01T08:00:00.000Z" });
  const mainNewest = session("main-newest", {
    cwd: "/workspace/beta",
    modified: "2026-07-14T10:00:00.000Z",
  });
  const worktree = session("worktree", {
    cwd: "/workspace/beta-feature",
    projectRoot: "/workspace/beta",
    worktreeBranch: "feature",
    modified: "2026-07-13T10:00:00.000Z",
  });
  const fallbackRoot = session("fallback", {
    cwd: "/workspace/gamma",
    projectRoot: undefined,
    modified: "2026-07-10T10:00:00.000Z",
  });
  const pathless = session("pathless", { cwd: "", projectRoot: "" });

  const groups = groupSessionsByProject([older, mainNewest, worktree, fallbackRoot, pathless]);

  assert.deepEqual(
    groups.map((group) => group.projectRoot),
    ["/workspace/beta", "/workspace/gamma", "/workspace/alpha"],
  );
  assert.deepEqual(
    groups[0].sessions.map((item) => item.id),
    ["main-newest", "worktree"],
  );
  assert.equal(groups[0].latestModified, "2026-07-14T10:00:00.000Z");
  assert.equal(groups[2].latestModified, "2026-07-01T08:00:00.000Z");
  assert.deepEqual(groupSessionsByProject([]), []);
});

test("empty project roots keep the active project and remembered projects listed", () => {
  const sessionRoots = ["/workspace/beta"];

  // The active project leads so a freshly opened one is easy to spot.
  assert.deepEqual(resolveEmptyProjectRoots(sessionRoots, "/workspace/gamma", ["/workspace/delta"]), [
    "/workspace/gamma",
    "/workspace/delta",
  ]);

  // A project that already has sessions is not repeated as an empty group.
  assert.deepEqual(resolveEmptyProjectRoots(sessionRoots, "/workspace/beta", ["/workspace/delta"]), [
    "/workspace/delta",
  ]);
  assert.deepEqual(resolveEmptyProjectRoots(sessionRoots, "/workspace\\beta", ["/workspace/delta"]), [
    "/workspace/delta",
  ]);

  // Nothing selected and nothing remembered means no empty groups.
  assert.deepEqual(resolveEmptyProjectRoots(sessionRoots, null, []), []);
  assert.deepEqual(resolveEmptyProjectRoots([], null, ["/workspace/delta", "/workspace/delta"]), ["/workspace/delta"]);
});
