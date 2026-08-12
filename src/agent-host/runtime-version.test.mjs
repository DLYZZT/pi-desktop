import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const { readPiRuntimeVersion } = await importTestBundle("src/agent-host/runtime-version", {
  packages: "external",
  absWorkingDir: root,
  entryPoints: ["src/agent-host/runtime-version.ts"],
});

test("runtime version resolves through the public ESM entry despite package export restrictions", () => {
  assert.equal(readPiRuntimeVersion(), "0.84.0");
});
