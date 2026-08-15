import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeWorktreePathForComparison,
  removeWorktree,
  setGitCommandRunner,
  worktreePathsEqual,
} from "./worktree.ts";

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

test("worktree removal matches alternate separators and passes Git its canonical path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, "repo");
  const linked = `${main}-worktrees${path.sep}feature`;
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(linked, { recursive: true });

  const calls = [];
  const restore = setGitCommandRunner({
    async run(cwd, args) {
      calls.push({ cwd, args });
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: [
            `worktree ${main}`,
            "HEAD 0000000000000000000000000000000000000000",
            "branch refs/heads/main",
            "",
            `worktree ${linked}`,
            "HEAD 1111111111111111111111111111111111111111",
            "branch refs/heads/feature",
            "",
          ].join("\n"),
        };
      }
      return { stdout: "" };
    },
  });
  t.after(restore);

  await removeWorktree(main, linked.replaceAll(path.sep, path.sep === "/" ? "\\" : "/"));

  assert.deepEqual(calls.at(-1)?.args, ["worktree", "remove", linked]);
});
