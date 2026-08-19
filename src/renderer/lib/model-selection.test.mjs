import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
let modulePromise;

async function loadModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/renderer/lib/model-selection", {
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/model-selection.ts"],
    });
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

test("enabling a custom provider adds its exact refs to enabled models", async () => {
  const { setProviderModelsEnabled, isModelEnabled } = await loadModule();
  const current = ["openrouter-jb/z-ai/glm-5.2"];
  const withGlm = setProviderModelsEnabled(
    [
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
      { provider: "glm5.3", id: "z-ai/glm-5.3", name: "glm" },
    ],
    current,
    "glm5.3",
    true,
  );
  assert.ok(withGlm, "expected a concrete enabled-models list");
  assert.ok(withGlm.includes("glm5.3/z-ai/glm-5.3"));
  assert.ok(isModelEnabled({ provider: "glm5.3", id: "z-ai/glm-5.3", name: "glm" }, withGlm));
});
