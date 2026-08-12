import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorktreePathForComparison, worktreePathsEqual } from "./worktree.ts";

test("Windows worktree paths compare independent of slash, drive case, path case, and trailing separators", () => {
  assert.equal(worktreePathsEqual("C:\\Users\\Dev\\Repo", "c:/users/dev/repo/", "win32"), true);
  assert.equal(worktreePathsEqual("C:\\Users\\Dev\\Repo", "D:/users/dev/repo", "win32"), false);
  assert.equal(worktreePathsEqual("\\\\Server\\Share\\Repo\\", "//server/share/repo", "win32"), true);
  assert.equal(normalizeWorktreePathForComparison("C:\\", "win32"), "c:/");
});

test("POSIX worktree paths normalize separators without changing case", () => {
  assert.equal(worktreePathsEqual("/Users/Dev/Repo/", "/Users/Dev/Repo", "darwin"), true);
  assert.equal(worktreePathsEqual("/Users/Dev/Repo", "/users/dev/repo", "darwin"), false);
  assert.equal(normalizeWorktreePathForComparison("/", "linux"), "/");
});

test("git dir and common dir comparisons share the same Windows canonical rules", () => {
  assert.equal(worktreePathsEqual("C:\\repo\\.git", "c:/REPO/.git/", "win32"), true);
  assert.equal(worktreePathsEqual("C:\\repo\\.git\\worktrees\\feature", "c:/repo/.git", "win32"), false);
});
