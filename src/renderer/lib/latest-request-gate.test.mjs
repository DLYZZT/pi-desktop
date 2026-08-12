import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
let modulePromise;

async function loadModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/renderer/lib/latest-request-gate", {
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/latest-request-gate.ts"],
    });
  })();
  return modulePromise;
}

test("only the newest model-list request may publish its result", async () => {
  const { LatestRequestGate } = await loadModule();
  const gate = new LatestRequestGate();
  const cacheLoad = gate.begin();
  const networkRefresh = gate.begin();

  assert.equal(gate.isCurrent(cacheLoad), false);
  assert.equal(gate.isCurrent(networkRefresh), true);

  gate.invalidate();
  assert.equal(gate.isCurrent(networkRefresh), false);
});
