import assert from "node:assert/strict";
import test from "node:test";
import { createToolchainGitRunner } from "./toolchain-git.ts";

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
