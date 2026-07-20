import assert from "node:assert/strict";
import test from "node:test";
import { createToolchainBashOptions } from "./toolchain-bash.ts";

function context(commands) {
  return {
    inventoryRevision: 21,
    resolutionId: "resolution-21",
    cwd: "/workspace",
    intent: "agent-shell",
    commands,
    nativeEnv: { PATH: "/native" },
    shellEnv: { PATH: "/resolved/bin:/usr/bin", PI_DESKTOP_TOOLCHAIN_REVISION: "21" },
    summary: [],
  };
}

test("pins Agent Bash to the resolved executable and context-local environment", () => {
  const descriptor = {
    capability: "shell.bash",
    provider: "system",
    executable: "/resolved/bin/bash",
    argvPrefix: [],
    binDir: "/resolved/bin",
    version: "5.2.0",
    cwdSemantics: "posix",
    envPatch: {},
  };
  const options = createToolchainBashOptions(context({ "shell.bash": descriptor }), undefined, "source profile");
  assert.equal(options.shellPath, "/resolved/bin/bash");
  assert.equal(options.commandPrefix, "source profile");
  const spawned = options.spawnHook({ command: "/resolved/bin/bash", args: [], env: { KEEP: "yes" } });
  assert.deepEqual(spawned.env, {
    KEEP: "yes",
    PATH: "/resolved/bin:/usr/bin",
    PI_DESKTOP_TOOLCHAIN_REVISION: "21",
  });
  assert.equal(process.env.PI_DESKTOP_TOOLCHAIN_REVISION, undefined);
});

test("reports structured Bash absence and never falls back to PATH", async () => {
  const missing = Object.assign(new Error("Bash required"), {
    code: "TOOLCHAIN_BASH_REQUIRED",
    capability: "shell.bash",
  });
  const runtime = {
    requireFromContext(capability) {
      assert.equal(capability, "shell.bash");
      throw missing;
    },
  };
  const options = createToolchainBashOptions(context({}), runtime);
  await assert.rejects(options.operations.exec("echo test", { cwd: "/workspace" }), missing);
});
