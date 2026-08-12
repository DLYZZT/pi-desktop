import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
let modulePromise;

async function loadModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/renderer/lib/models-config-state", {
      absWorkingDir: root,
      entryPoints: ["src/renderer/lib/models-config-state.ts"],
    });
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

test("setting a built-in provider base URL creates an override without redefining models", async () => {
  const { setProviderBaseUrl } = await loadModule();
  const original = { revision: 7, providers: {} };

  const updated = setProviderBaseUrl(original, "openai", "  https://proxy.example.com/v1  ");

  assert.deepEqual(updated, {
    revision: 7,
    providers: { openai: { baseUrl: "https://proxy.example.com/v1" } },
  });
  assert.deepEqual(original, { revision: 7, providers: {} });
});

test("clearing a provider base URL preserves other provider fields and removes empty overrides", async () => {
  const { setProviderBaseUrl } = await loadModule();
  const withOtherFields = {
    providers: {
      openai: {
        baseUrl: "https://proxy.example.com/v1",
        headers: { "X-Tenant": "tenant-one", "X-Optional": null },
        futureField: true,
      },
    },
  };

  assert.deepEqual(setProviderBaseUrl(withOtherFields, "openai", ""), {
    providers: {
      openai: {
        headers: { "X-Tenant": "tenant-one", "X-Optional": null },
        futureField: true,
      },
    },
  });
  assert.deepEqual(
    setProviderBaseUrl({ providers: { openai: { baseUrl: "https://proxy.example.com/v1" } } }, "openai", "  "),
    { providers: {} },
  );
});

test("provider rename rejects conflicts and reserved or empty names without changing config", async () => {
  const { renameProviderEntry } = await loadModule();
  const original = {
    revision: 7,
    providers: {
      alpha: { api: "openai-completions", futureField: "alpha" },
      beta: { api: "anthropic-messages", futureField: "beta" },
    },
  };

  for (const requestedName of [" beta ", "", "   ", "__proto__", "prototype", "constructor"]) {
    const result = renameProviderEntry(original, "alpha", requestedName);
    assert.equal(result.ok, false, requestedName);
    assert.equal(result.config, original);
    assert.deepEqual(Object.keys(original.providers), ["alpha", "beta"]);
  }

  const renamed = renameProviderEntry(original, "alpha", " gamma ");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.name, "gamma");
  assert.deepEqual(Object.keys(renamed.config.providers), ["gamma", "beta"]);
  assert.deepEqual(renamed.config.providers.gamma, original.providers.alpha);
  assert.deepEqual(renamed.config.providers.beta, original.providers.beta);
  assert.deepEqual(Object.keys(original.providers), ["alpha", "beta"]);
});

test("provider deletion and model addition compute config and selection without side effects", async () => {
  const { addModelTransition, deleteProviderTransition, selectionAfterProviderRename } = await loadModule();
  const original = {
    revision: 7,
    providers: {
      alpha: { models: [{ id: "one" }], futureField: true },
      beta: { api: "anthropic-messages" },
    },
  };
  const selectedBeta = { type: "provider", name: "beta" };

  const unrelatedDelete = deleteProviderTransition(original, selectedBeta, "alpha");
  assert.equal(unrelatedDelete.selection, selectedBeta);
  assert.deepEqual(Object.keys(unrelatedDelete.config.providers), ["beta"]);

  const selectedAlphaModel = { type: "model", providerName: "alpha", index: 0 };
  const selectedDelete = deleteProviderTransition(original, selectedAlphaModel, "alpha");
  assert.deepEqual(selectedDelete.selection, { type: "provider", name: "beta" });
  assert.deepEqual(Object.keys(selectedDelete.config.providers), ["beta"]);

  const added = addModelTransition(original, "alpha");
  assert.deepEqual(added.selection, { type: "model", providerName: "alpha", index: 1 });
  assert.deepEqual(added.config.providers.alpha.models, [{ id: "one" }, { id: "" }]);
  assert.equal(added.config.providers.alpha.futureField, true);

  assert.deepEqual(selectionAfterProviderRename(selectedAlphaModel, "alpha", "gamma"), {
    type: "model",
    providerName: "gamma",
    index: 0,
  });
  assert.deepEqual(original.providers.alpha.models, [{ id: "one" }]);
  assert.equal(original.providers.alpha.futureField, true);
});

test("consecutive custom providers derive unique names from the reducer current state", async () => {
  const { modelsConfigEditorReducer } = await loadModule();
  const original = {
    config: {
      revision: 7,
      providers: { "new-provider": { api: "anthropic-messages", futureField: true } },
    },
    selection: null,
  };

  const first = modelsConfigEditorReducer(original, { type: "provider.addCustom" });
  const second = modelsConfigEditorReducer(first, { type: "provider.addCustom" });

  assert.deepEqual(Object.keys(second.config.providers), ["new-provider", "new-provider-1", "new-provider-2"]);
  assert.deepEqual(second.config.providers["new-provider-1"], { api: "openai-completions" });
  assert.deepEqual(second.config.providers["new-provider-2"], { api: "openai-completions" });
  assert.deepEqual(second.selection, { type: "provider", name: "new-provider-2" });
  assert.deepEqual(original.config.providers, {
    "new-provider": { api: "anthropic-messages", futureField: true },
  });
});
