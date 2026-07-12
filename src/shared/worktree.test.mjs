import test from "node:test";
import assert from "node:assert/strict";

test("parses staged, modified, untracked, and conflicted git status entries", async () => {
  const { parseGitStatusPorcelain } = await import("./git-status.ts");
  const result = parseGitStatusPorcelain(
    ["M  staged.ts", " M modified.ts", "?? new.ts", "UU conflict.ts", "A  both.ts", " M both.ts", ""].join("\0"),
    "feature/status",
  );

  assert.equal(result.branch, "feature/status");
  assert.equal(result.clean, false);
  assert.equal(result.staged, 2);
  assert.equal(result.modified, 2);
  assert.equal(result.untracked, 1);
  assert.equal(result.conflicted, 1);
  assert.equal(result.entries.length, 6);
});

test("skips the original path record emitted for porcelain rename entries", async () => {
  const { parseGitStatusPorcelain } = await import("./git-status.ts");
  const result = parseGitStatusPorcelain("R  new-name.ts\0old-name.ts\0", "main");

  assert.equal(result.staged, 1);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["new-name.ts"],
  );
});

test("reports a clean repository for empty porcelain output", async () => {
  const { parseGitStatusPorcelain } = await import("./git-status.ts");
  const result = parseGitStatusPorcelain("", null);

  assert.equal(result.clean, true);
  assert.deepEqual(result.entries, []);
});
