import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoLegacyTestBundleUsage, findLegacyTestBundleUsage, importTestBundle } from "./test-bundle.mjs";

test("bundles TypeScript in an OS temp directory and removes it after import", async (t) => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pi-test-bundle-contract-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  let cleanup;

  const module = await importTestBundle(
    "helper-contract",
    {
      stdin: {
        contents: "export const answer: number = 42;",
        sourcefile: "helper-contract.ts",
        loader: "ts",
      },
    },
    { temporaryRoot, registerCleanup: (callback) => (cleanup = callback) },
  );

  assert.equal(module.answer, 42);
  assert.equal(readdirSync(temporaryRoot).length, 1);
  cleanup();
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test("rejects output overrides and identifies legacy per-test bundling", async () => {
  await assert.rejects(importTestBundle("unsafe", { outfile: "/tmp/escape.mjs" }), /cannot override outfile/);
  assert.deepEqual(findLegacyTestBundleUsage('import { build } from "esbuild";'), ["direct esbuild import"]);
  assert.deepEqual(findLegacyTestBundleUsage('const output = ".artifacts/test-modules/x.mjs";'), [
    "repository test-modules output",
  ]);
  assert.deepEqual(findLegacyTestBundleUsage('import { importTestBundle } from "#test-bundle";'), []);
});

test("repository policy reports every legacy bundle owner", () => {
  const files = new Map([
    ["src/direct.test.mjs", 'import { build } from "esbuild";'],
    ["src/artifact.test.mjs", 'const output = ".artifacts/test-modules/test.mjs";'],
  ]);
  assert.throws(
    () =>
      assertNoLegacyTestBundleUsage("/fixture", {
        globSync: () => [...files.keys()],
        readFileSync: (file) => files.get(file.replace("/fixture/", "")),
      }),
    (error) =>
      error.message.includes("src/direct.test.mjs: direct esbuild import") &&
      error.message.includes("src/artifact.test.mjs: repository test-modules output"),
  );
});
