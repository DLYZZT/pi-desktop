import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertNoLegacyTestBundleUsage } from "./test-bundle.mjs";

const defaultTimeoutMs = 120_000;

export function parseTestTimeout(value) {
  if (value === undefined || value === "") return defaultTimeoutMs;
  if (!/^\d+$/.test(value)) throw new Error(`PI_TEST_TIMEOUT_MS must be a positive integer, received ${value}`);
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`PI_TEST_TIMEOUT_MS must be a positive integer, received ${value}`);
  }
  return timeout;
}

export function createTestCommand({ timeoutMs = defaultTimeoutMs } = {}) {
  return {
    command: process.execPath,
    args: [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--test",
      `--test-timeout=${timeoutMs}`,
      "src/**/*.test.mjs",
    ],
  };
}

export function assertTestSpawnResult(result) {
  if (result.error) throw new Error(`test runner failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`test runner terminated by signal ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error("test runner returned no exit status");
  if (result.status !== 0) throw new Error(`test runner exited with status ${result.status}`);
}

export function cleanLegacyTestModules(root, fileSystem = fs) {
  fileSystem.rmSync(path.join(root, ".artifacts", "test-modules"), { recursive: true, force: true });
}

export function runTests(root, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const fileSystem = options.fileSystem ?? fs;
  const command = createTestCommand({ timeoutMs: parseTestTimeout(options.timeout ?? process.env.PI_TEST_TIMEOUT_MS) });
  assertNoLegacyTestBundleUsage(root);
  cleanLegacyTestModules(root, fileSystem);
  try {
    const result = spawn(command.command, command.args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    assertTestSpawnResult(result);
  } finally {
    cleanLegacyTestModules(root, fileSystem);
  }
}
