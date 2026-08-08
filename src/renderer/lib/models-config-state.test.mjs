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
    const outputFile = path.join(outputDirectory, `models-config-state-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/models-config-state.ts"],
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

test("editing one model preserves v0.84 sampling, nullable headers, and unknown fields", async () => {
  const { replaceModelEntry } = await loadModule();
  const original = {
    revision: 7,
    providers: {
      custom: {
        api: "openai-completions",
        headers: { Authorization: "Bearer test", "X-Remove-Me": null },
        futureProviderField: { nested: true },
        models: [
          {
            id: "model-one",
            name: "Old name",
            samplingParams: { temperature: 0.25, thinking_token_budget: 2048 },
            compat: { futureCompat: "preserved" },
            futureModelField: [1, 2, 3],
          },
        ],
      },
    },
  };
  const selected = original.providers.custom.models[0];
  const updated = replaceModelEntry(original, "custom", 0, { ...selected, name: "New name" });

  assert.equal(updated.providers.custom.models[0].name, "New name");
  assert.deepEqual(updated.providers.custom.models[0].samplingParams, selected.samplingParams);
  assert.deepEqual(updated.providers.custom.models[0].futureModelField, selected.futureModelField);
  assert.deepEqual(updated.providers.custom.headers, original.providers.custom.headers);
  assert.deepEqual(updated.providers.custom.futureProviderField, original.providers.custom.futureProviderField);
  assert.equal(updated.revision, 7);
  assert.equal(original.providers.custom.models[0].name, "Old name");
});
