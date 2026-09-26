import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertTestSpawnResult, createTestCommand, parseTestTimeout, runTests } from "./test-runner.mjs";

test("test discovery includes source and script tests and applies a per-test timeout", () => {
  const command = createTestCommand({ timeoutMs: 4567 });
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--test",
    "--test-timeout=4567",
    "src/**/*.test.mjs",
    "scripts/**/*.test.mjs",
  ]);
  assert.equal(command.args.filter((argument) => argument.endsWith(".test.mjs")).length, 2);
});

test("the real runner executes both test roots and propagates a script test failure", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-test-discovery with spaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "scripts", "nested"), { recursive: true });
  const passingTest = (marker) =>
    `import test from "node:test"; import { writeFileSync } from "node:fs";
     test("${marker}", () => writeFileSync("${marker}", "executed"));`;
  writeFileSync(path.join(root, "src", "source.test.mjs"), passingTest("source-executed"));
  const scriptTest = path.join(root, "scripts", "nested", "script.test.mjs");
  writeFileSync(scriptTest, passingTest("script-executed"));
  writeFileSync(path.join(root, "scripts", "test-electron.mjs"), 'throw new Error("not a unit test");');
  let result;
  const options = {
    timeout: "5000",
    spawnSync(command, args, spawnOptions) {
      const env = { ...process.env };
      // Run an independent CLI fixture, not a recursive child of this test worker.
      delete env.NODE_TEST_CONTEXT;
      result = spawnSync(command, args, { ...spawnOptions, env, stdio: "pipe", encoding: "utf8", timeout: 10_000 });
      return result;
    },
  };

  runTests(root, options);
  assert.equal(existsSync(path.join(root, "source-executed")), true, result.stdout + result.stderr);
  assert.equal(existsSync(path.join(root, "script-executed")), true, result.stdout + result.stderr);

  writeFileSync(
    scriptTest,
    'import test from "node:test"; test("script failure", () => { throw new Error("fixture failure"); });',
  );
  mkdirSync(path.join(root, ".artifacts", "test-modules"), { recursive: true });
  assert.throws(() => runTests(root, options), /test runner exited with status 1/);
  assert.match(result.stdout, /fixture failure/);
  assert.equal(existsSync(path.join(root, ".artifacts", "test-modules")), false);
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
          assert.equal(args.at(-1), "scripts/**/*.test.mjs");
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
