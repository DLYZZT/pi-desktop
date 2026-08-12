import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
let modulePromise;

async function loadModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const outputDirectory = path.join(root, ".artifacts", "test-modules");
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, `latest-request-gate-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/latest-request-gate.ts"],
      outfile: outputFile,
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: false,
      logLevel: "silent",
    });
    return import(`${pathToFileURL(outputFile).href}?v=${Date.now()}`);
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
