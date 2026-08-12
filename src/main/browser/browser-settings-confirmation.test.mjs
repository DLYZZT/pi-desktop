import assert from "node:assert/strict";
import test from "node:test";

import { BrowserConfirmationManager } from "./browser-confirmation.ts";
import { authorizeBrowserSettingsUpdate, prepareBrowserSettingsUpdate } from "./browser-settings-confirmation.ts";
import { createDefaultBrowserSettings } from "./browser-settings.ts";

test("invalid settings patches fail before consuming their confirmation proof", () => {
  const current = createDefaultBrowserSettings();
  const validPatch = { advancedBrowserMode: { enabled: true } };
  const canonicalPatch = prepareBrowserSettingsUpdate(current, validPatch).canonicalPatch;
  const confirmations = new BrowserConfirmationManager({ createId: () => "proof" });
  const proof = confirmations.issue("advanced-browser-mode", canonicalPatch);
  let consumeCount = 0;

  for (const [invalidPatch, expected] of [
    [{ advancedBrowserMode: { enabled: true }, surprise: true }, /not supported/],
    [{ advancedBrowserMode: { enabled: true }, navigation: { maxTabs: 0 } }, /navigation.maxTabs/],
  ]) {
    assert.throws(
      () =>
        authorizeBrowserSettingsUpdate(current, invalidPatch, (payload) => {
          consumeCount += 1;
          confirmations.consume(proof, "advanced-browser-mode", payload);
        }),
      expected,
    );
  }
  assert.equal(consumeCount, 0);

  authorizeBrowserSettingsUpdate(current, validPatch, (payload) => {
    consumeCount += 1;
    confirmations.consume(proof, "advanced-browser-mode", payload);
  });
  assert.equal(consumeCount, 1);
});

test("confirmation proof digest is bound to the validated canonical patch", () => {
  const current = createDefaultBrowserSettings();
  const first = prepareBrowserSettingsUpdate(current, {
    navigation: { allowHttp: true },
    advancedBrowserMode: { enabled: true },
  }).canonicalPatch;
  const reordered = prepareBrowserSettingsUpdate(current, {
    advancedBrowserMode: { enabled: true },
    navigation: { allowHttp: true },
  }).canonicalPatch;
  const confirmations = new BrowserConfirmationManager({ createId: () => "proof" });
  const proof = confirmations.issue("advanced-browser-mode", first);

  confirmations.consume(proof, "advanced-browser-mode", reordered);
});

test("prepared settings patches are isolated canonical clones without disable rewriting", () => {
  const current = createDefaultBrowserSettings();
  const input = { advancedBrowserMode: { enabled: false, maxPerHost: 25 } };
  const prepared = prepareBrowserSettingsUpdate(current, input);

  assert.notEqual(prepared.canonicalPatch, input);
  assert.notEqual(prepared.canonicalPatch.advancedBrowserMode, input.advancedBrowserMode);
  assert.deepEqual(prepared.canonicalPatch, input);
  assert.equal(prepared.requiresAdvancedConfirmation, false);

  input.advancedBrowserMode.maxPerHost = 30;
  assert.equal(prepared.canonicalPatch.advancedBrowserMode.maxPerHost, 25);
});
