import assert from "node:assert/strict";
import test from "node:test";

import { installHttpIdleTimeout, loadPiHttpDispatcher } from "./http-idle-timeout.ts";

test("installHttpIdleTimeout applies the settings timeout to the dispatcher", async () => {
  const seen = [];
  const timeoutMs = await installHttpIdleTimeout(async () => ({
    configureHttpDispatcher(value) {
      seen.push(value);
    },
  }));
  assert.equal(typeof timeoutMs, "number");
  assert.ok(timeoutMs >= 0);
  assert.deepEqual(seen, [timeoutMs]);
});

test("loadPiHttpDispatcher resolves the ESM-only pi package", async () => {
  const dispatcher = await loadPiHttpDispatcher();
  assert.equal(typeof dispatcher.configureHttpDispatcher, "function");
});
