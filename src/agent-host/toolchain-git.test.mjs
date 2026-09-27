import assert from "node:assert/strict";
import test from "node:test";
import { createToolchainGitRunner, installToolchainGitRunner } from "./toolchain-git.ts";

test("routes direct Git operations through the resolved capability and revision context", async () => {
  const calls = [];
  const runtime = {
    async exec(capability, args, options) {
      calls.push({ capability, args, options });
      return { stdout: "main\n", stderr: "", context: { inventoryRevision: 9 } };
    },
  };
  const runner = createToolchainGitRunner(runtime);
  const result = await runner.run("/workspace with spaces", ["rev-parse", "--abbrev-ref", "HEAD"], {
    timeout: 10_000,
    maxBuffer: 1024,
    env: { LC_ALL: "C" },
  });

  assert.equal(result.stdout, "main\n");
  assert.deepEqual(calls, [
    {
      capability: "vcs.git",
      args: ["-C", "/workspace with spaces", "rev-parse", "--abbrev-ref", "HEAD"],
      options: {
        cwd: "/workspace with spaces",
        intent: "git-operation",
        env: { LC_ALL: "C" },
        timeout: 10_000,
        maxBuffer: 1024,
      },
    },
  ]);
});

test("Git project fallback caches are invalidated once after a toolchain revision becomes usable", async (t) => {
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ToolchainRuntime } = await import("./toolchain-runtime.ts");
  const { resolveProject, invalidateProjectCache, getProjectCacheRevision } = await import("../shared/worktree.ts");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-toolchain-project-")));
  const runtime = new ToolchainRuntime();
  runtime.apply({ revision: 0 });
  t.mock.method(runtime, "exec", async () => {
    if (runtime.getSnapshot().revision === 0) throw new Error("Git not ready");
    return { stdout: `${directory}/.git\n${directory}/.git\n${directory}\nmain\n` };
  });
  const notifications = [];
  const restore = installToolchainGitRunner(runtime, () => notifications.push(getProjectCacheRevision()));
  invalidateProjectCache();
  t.after(() => {
    restore();
    invalidateProjectCache();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await resolveProject(directory)).isTopLevel, false);
  const revision = getProjectCacheRevision();
  runtime.apply({ revision: 1 });
  assert.equal((await resolveProject(directory)).isTopLevel, true);
  assert.deepEqual(notifications, [revision + 1]);
  runtime.apply({ revision: 1 });
  runtime.apply({ revision: 0 });
  assert.deepEqual(notifications, [revision + 1]);
  restore();
  runtime.apply({ revision: 2 });
  assert.deepEqual(notifications, [revision + 1]);
});
