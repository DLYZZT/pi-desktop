import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertSuccessfulSpawn,
  resolveElectronBinary,
  resolvePackageFile,
  terminateProcessTree,
} from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("script dependencies resolve to real package files and the Electron executable", () => {
  const electron = resolveElectronBinary(root);
  const esbuild = resolvePackageFile(root, "esbuild", "bin/esbuild");
  const tsup = resolvePackageFile(root, "tsup", "dist/cli-default.js");
  for (const executable of [electron, esbuild, tsup]) {
    assert.equal(existsSync(executable), true, executable);
    assert.equal(executable.endsWith(".cmd"), false, executable);
  }
});

test("spawn result validation reports errors, signals, missing statuses, and exit codes", () => {
  assert.equal(assertSuccessfulSpawn({ error: undefined, signal: null, status: 0 }, "build").status, 0);
  assert.throws(() => assertSuccessfulSpawn({ error: new Error("ENOENT") }, "build"), /failed to start: ENOENT/);
  assert.throws(() => assertSuccessfulSpawn({ signal: "SIGKILL", status: null }, "build"), /signal SIGKILL/);
  assert.throws(() => assertSuccessfulSpawn({ signal: null, status: null }, "build"), /no exit status/);
  assert.throws(() => assertSuccessfulSpawn({ signal: null, status: 9 }, "build"), /status 9/);
});

test("process tree termination targets Windows descendants and POSIX process groups", () => {
  let taskkillCall;
  assert.equal(
    terminateProcessTree(
      { pid: 41 },
      {
        platform: "win32",
        spawnSync: (command, args, options) => {
          taskkillCall = { command, args, options };
          return { error: undefined, status: 0 };
        },
      },
    ),
    true,
  );
  assert.deepEqual(taskkillCall.args, ["/pid", "41", "/T", "/F"]);

  let groupKill;
  assert.equal(
    terminateProcessTree(
      { pid: 73, kill: () => assert.fail("group kill should succeed") },
      {
        platform: "linux",
        kill: (pid, signal) => {
          groupKill = { pid, signal };
        },
      },
    ),
    true,
  );
  assert.deepEqual(groupKill, { pid: -73, signal: "SIGTERM" });
});
