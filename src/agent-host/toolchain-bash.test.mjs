import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("removes host credentials from Agent Bash environment", () => {
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
  const toolContext = context({ "shell.bash": descriptor });
  toolContext.shellEnv.XAI_API_KEY = "provider-secret";
  toolContext.shellEnv.CLI_PROXY_API_KEY = "proxy-secret";
  const options = createToolchainBashOptions(toolContext);
  const spawned = options.spawnHook({
    command: "/resolved/bin/bash",
    args: [],
    env: { GITHUB_TOKEN: "github-secret", SAFE_VALUE: "kept" },
  });
  assert.equal(spawned.env.XAI_API_KEY, undefined);
  assert.equal(spawned.env.CLI_PROXY_API_KEY, undefined);
  assert.equal(spawned.env.GITHUB_TOKEN, undefined);
  assert.equal(spawned.env.SAFE_VALUE, "kept");
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

test(
  "aborting Desktop Bash does not run the next command in the list",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-150-bash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const options = createToolchainBashOptions(context({ "shell.bash": { executable: "/bin/bash" } }));
    const controller = new globalThis.AbortController();
    let output = "";
    await assert.rejects(
      options.operations.exec("printf 'ready\\n'; /bin/sleep 30; printf 'must-not-run\\n'", root, {
        signal: controller.signal,
        timeout: 5,
        onData: (chunk) => {
          output += chunk.toString();
          if (output.includes("ready")) controller.abort();
        },
      }),
      /abort/i,
    );
    assert.match(output, /ready/);
    assert.doesNotMatch(output, /must-not-run/);
  },
);
