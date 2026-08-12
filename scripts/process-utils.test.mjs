import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertSuccessfulSpawn, resolveElectronBinary, resolvePackageFile } from "./process-utils.mjs";

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
