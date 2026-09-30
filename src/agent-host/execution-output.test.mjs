import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { captureExecutionOutput, ExecutionLogStore } = await importTestBundle("durable-sdk-output", {
  packages: "external",
  stdin: {
    contents:
      'export {captureExecutionOutput} from "./execution-output.ts"; export {ExecutionLogStore} from "./execution-log-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("temporary output capture refuses server-supplied paths, symlinks and oversized files", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-spill-security-")),
    privateFile = path.join(root, "private.txt"),
    spill = path.join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`),
    store = new ExecutionLogStore("spill-test", root);
  t.after(() => {
    rmSync(spill, { force: true });
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(privateFile, "SHOULD_NOT_READ");
  assert.equal(
    await captureExecutionOutput(store, "mcp__server__tool", { details: { fullOutputPath: privateFile } }),
    undefined,
  );
  assert.equal(
    (await captureExecutionOutput(store, "codemode", { details: { fullOutputPath: privateFile } })).complete,
    false,
  );
  if (process.platform !== "win32") {
    symlinkSync(privateFile, spill);
    const linked = await captureExecutionOutput(store, "codemode", { details: { fullOutputPath: spill } });
    assert.equal(linked.complete, false);
    assert.doesNotMatch(JSON.stringify(linked), /SHOULD_NOT_READ/);
    rmSync(spill);
  }
  writeFileSync(spill, "");
  truncateSync(spill, 33 * 1024 * 1024);
  const oversized = await captureExecutionOutput(store, "codemode", { details: { fullOutputPath: spill } });
  assert.equal(oversized.complete, false);
  assert.match(oversized.reason, /budget/);
});
