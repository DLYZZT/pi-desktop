import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolchainRuntime } from "./toolchain-runtime.ts";
import { runNpxWithRuntime } from "./npx.ts";

function createRuntime(descriptor, revision = 5) {
  const snapshot = {
    revision,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    candidates: [],
    defaults: { "js.npx": descriptor },
    publicState: {
      schemaVersion: 1,
      revision,
      platform: process.platform,
      arch: process.arch,
      coreReady: true,
      capabilities: {},
      components: {},
      operations: [],
    },
  };
  const resolution = {
    id: "npx-resolution",
    inventoryRevision: revision,
    workspaceKey: "workspace",
    requirementsHash: "requirements",
    commands: { "js.npx": descriptor },
    summary: [],
  };
  return new ToolchainRuntime({
    fetchSnapshot: async () => snapshot,
    resolveProject: async () => resolution,
  });
}

test("runs the resolved absolute Node and npx CLI with the resolution environment", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-npx-runtime-"));
  try {
    const cli = path.join(directory, "npx-cli.cjs");
    writeFileSync(
      cli,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),revision:process.env.PI_DESKTOP_TOOLCHAIN_REVISION,maxSockets:process.env.npm_config_maxsockets,yes:process.env.npm_config_yes,updateNotifier:process.env.npm_config_update_notifier}))",
      "utf8",
    );
    const descriptor = {
      capability: "js.npx",
      provider: "system",
      executable: process.execPath,
      argvPrefix: [cli],
      binDir: path.dirname(process.execPath),
      version: "10.9.7",
      cwdSemantics: "posix",
      envPatch: {},
    };
    const runtime = createRuntime(descriptor);
    const result = await runNpxWithRuntime(["skills", "find", "hello world"], { cwd: directory }, runtime);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["skills", "find", "hello world"],
      revision: "5",
      yes: "true",
      updateNotifier: "false",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries a network failure once with an isolated cache and one registry socket", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-npx-retry-"));
  try {
    const cli = path.join(directory, "npx-cli.cjs");
    writeFileSync(
      cli,
      'if(process.env.npm_config_maxsockets!=="1"){process.stderr.write("network fetch failed");process.exit(1)}process.stdout.write(JSON.stringify({cache:process.env.npm_config_cache,maxSockets:process.env.npm_config_maxsockets}))',
      "utf8",
    );
    const descriptor = {
      capability: "js.npx",
      provider: "system",
      executable: process.execPath,
      argvPrefix: [cli],
      binDir: path.dirname(process.execPath),
      version: "10.9.7",
      cwdSemantics: "posix",
      envPatch: {},
    };
    const result = await runNpxWithRuntime(["skills", "find", "test"], { cwd: directory }, createRuntime(descriptor));
    const recovery = JSON.parse(result.stdout);
    assert.equal(recovery.maxSockets, "1");
    assert.match(recovery.cache, /pi-desktop-npx-retry-/);
    assert.equal(existsSync(recovery.cache), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not retry a non-recoverable CLI failure", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-npx-no-retry-"));
  try {
    const cli = path.join(directory, "npx-cli.cjs");
    const attempts = path.join(directory, "attempts.txt");
    writeFileSync(
      cli,
      `require("node:fs").appendFileSync(${JSON.stringify(attempts)},"x");process.stderr.write("invalid skill package");process.exit(1)`,
      "utf8",
    );
    const descriptor = {
      capability: "js.npx",
      provider: "system",
      executable: process.execPath,
      argvPrefix: [cli],
      binDir: path.dirname(process.execPath),
      version: "10.9.7",
      cwdSemantics: "posix",
      envPatch: {},
    };
    await assert.rejects(
      runNpxWithRuntime(["skills", "add", "invalid"], { cwd: directory }, createRuntime(descriptor)),
    );
    assert.equal(readFileSync(attempts, "utf8"), "x");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports an actionable error when the developer command times out", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-npx-timeout-"));
  try {
    const cli = path.join(directory, "npx-cli.cjs");
    writeFileSync(cli, "setInterval(() => {}, 1000)", "utf8");
    const descriptor = {
      capability: "js.npx",
      provider: "system",
      executable: process.execPath,
      argvPrefix: [cli],
      binDir: path.dirname(process.execPath),
      version: "10.9.7",
      cwdSemantics: "posix",
      envPatch: {},
    };
    await assert.rejects(
      runNpxWithRuntime(["skills", "find", "test"], { cwd: directory, timeout: 25 }, createRuntime(descriptor)),
      /Developer command timed out after 1 seconds\. Check network connectivity and try again\./,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails with TOOLCHAIN_NODE_REQUIRED and never falls back to Electron or PATH", async () => {
  const runtime = new ToolchainRuntime({
    fetchSnapshot: async () => ({
      revision: 1,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      candidates: [],
      defaults: {},
      publicState: {
        schemaVersion: 1,
        revision: 1,
        platform: process.platform,
        arch: process.arch,
        coreReady: true,
        capabilities: {},
        components: {},
        operations: [],
      },
    }),
    resolveProject: async () => ({
      id: "missing",
      inventoryRevision: 1,
      workspaceKey: "workspace",
      requirementsHash: "requirements",
      commands: {},
      summary: [],
    }),
  });
  await assert.rejects(
    runNpxWithRuntime(["skills", "find", "test"], { cwd: process.cwd() }, runtime),
    (error) => error.code === "TOOLCHAIN_NODE_REQUIRED" && error.capability === "js.npx",
  );
});
