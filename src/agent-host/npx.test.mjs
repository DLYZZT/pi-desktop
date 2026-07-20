import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolchainRuntime } from "./toolchain-runtime.ts";
import { runNpxWithRuntime } from "./npx.ts";

test("runs the resolved absolute Node and npx CLI with the resolution environment", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-npx-runtime-"));
  try {
    const cli = path.join(directory, "npx-cli.cjs");
    writeFileSync(
      cli,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),revision:process.env.PI_DESKTOP_TOOLCHAIN_REVISION}))",
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
    const snapshot = {
      revision: 5,
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      candidates: [],
      defaults: { "js.npx": descriptor },
      publicState: {
        schemaVersion: 1,
        revision: 5,
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
      inventoryRevision: 5,
      workspaceKey: "workspace",
      requirementsHash: "requirements",
      commands: { "js.npx": descriptor },
      summary: [],
    };
    const runtime = new ToolchainRuntime({
      fetchSnapshot: async () => snapshot,
      resolveProject: async () => resolution,
    });
    const result = await runNpxWithRuntime(["skills", "find", "hello world"], { cwd: directory }, runtime);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["skills", "find", "hello world"],
      revision: "5",
    });
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
