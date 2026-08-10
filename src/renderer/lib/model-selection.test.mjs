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
    const outputFile = path.join(outputDirectory, `model-selection-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/model-selection.ts"],
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

const models = [
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
];

test("null preferences enable every available model and disabling one expands exact refs", async () => {
  const { isModelEnabled, toggleModelEnabled } = await loadModule();
  assert.equal(isModelEnabled(models[0], null), true);
  assert.deepEqual(toggleModelEnabled(models, null, models[1], false), ["anthropic/claude-sonnet", "openai/gpt-5"]);
});

test("bare ids and thinking suffixes are recognized while unknown refs are preserved", async () => {
  const { isModelEnabled, toggleModelEnabled } = await loadModule();
  const current = ["gpt-5:high", "future/model"];
  assert.equal(isModelEnabled(models[0], current), true);
  assert.deepEqual(toggleModelEnabled(models, current, models[1], true), [
    "future/model",
    "openai/gpt-5",
    "openai/gpt-5-mini",
  ]);
});

test("enabling every known model collapses preferences back to all models", async () => {
  const { setProviderModelsEnabled } = await loadModule();
  const current = ["anthropic/claude-sonnet"];
  assert.equal(setProviderModelsEnabled(models, current, "openai", true), null);
});
