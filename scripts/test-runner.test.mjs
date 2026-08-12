import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertTestSpawnResult, createTestCommand, parseTestTimeout, runTests } from "./test-runner.mjs";

test("test discovery uses one glob regardless of fixture count and applies a per-test timeout", () => {
  const command = createTestCommand({ timeoutMs: 4567 });
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--test",
    "--test-timeout=4567",
    "src/**/*.test.mjs",
  ]);
  assert.equal(command.args.filter((argument) => argument.endsWith(".test.mjs")).length, 1);
});

test("timeout parsing rejects malformed, zero, and unsafe values", () => {
  assert.equal(parseTestTimeout(undefined), 120_000);
  assert.equal(parseTestTimeout("9000"), 9000);
  for (const invalid of ["0", "-1", "5.5", "soon", "9007199254740992"]) {
    assert.throws(() => parseTestTimeout(invalid), /positive integer/);
  }
});

test("spawn diagnostics distinguish start errors, signals, missing statuses, and failures", () => {
  assert.doesNotThrow(() => assertTestSpawnResult({ error: undefined, signal: null, status: 0 }));
  assert.throws(() => assertTestSpawnResult({ error: new Error("ENOENT") }), /failed to start: ENOENT/);
  assert.throws(() => assertTestSpawnResult({ signal: "SIGKILL", status: null }), /signal SIGKILL/);
  assert.throws(() => assertTestSpawnResult({ signal: null, status: null }), /no exit status/);
  assert.throws(() => assertTestSpawnResult({ signal: null, status: 3 }), /status 3/);
});

test("legacy test modules are cleaned before and after every result", () => {
  const removed = [];
  assert.throws(
    () =>
      runTests("/repo", {
        timeout: "50",
        fileSystem: { rmSync: (target, options) => removed.push({ target, options }) },
        spawnSync: (command, args, options) => {
          assert.equal(command, process.execPath);
          assert.equal(args.at(-1), "src/**/*.test.mjs");
          assert.equal(options.shell, false);
          return { error: undefined, signal: null, status: 7 };
        },
      }),
    /status 7/,
  );
  assert.deepEqual(
    removed,
    [0, 1].map(() => ({
      target: path.join("/repo", ".artifacts", "test-modules"),
      options: { recursive: true, force: true },
    })),
  );
});
