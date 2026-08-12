import assert from "node:assert/strict";
import test from "node:test";

import { parseGitStatusPorcelain } from "./git-status.ts";

test("git status counts staged, modified, untracked, and conflict records", () => {
  const result = parseGitStatusPorcelain("M  staged.ts\0 M modified.ts\0?? new.ts\0UU conflict.ts\0", "main");
  assert.deepEqual(
    { staged: result.staged, modified: result.modified, untracked: result.untracked, conflicted: result.conflicted },
    { staged: 1, modified: 1, untracked: 1, conflicted: 1 },
  );
  assert.equal(result.clean, false);
  assert.equal(result.branch, "main");
});

test("rename source records are skipped and empty output is clean", () => {
  assert.deepEqual(
    parseGitStatusPorcelain("R  new.ts\0old.ts\0", null).entries.map(({ path }) => path),
    ["new.ts"],
  );
  assert.equal(parseGitStatusPorcelain("", null).clean, true);
});
