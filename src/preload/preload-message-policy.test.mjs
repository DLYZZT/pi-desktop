import assert from "node:assert/strict";
import test from "node:test";

import { isValidDeepLinkSessionMessage, selectTransferredHostPort } from "./preload-message-policy.ts";

test("host port messages require exactly one port-shaped transferable", () => {
  const port = { postMessage() {}, start() {}, close() {} };
  assert.equal(selectTransferredHostPort([port]), port);
  for (const ports of [[], [port, port], [null], [{}], [{ postMessage() {}, start() {} }]]) {
    assert.equal(selectTransferredHostPort(ports), undefined);
  }
});

test("deep-link messages accept only canonical session ids", () => {
  assert.equal(isValidDeepLinkSessionMessage("019ff6a4-2797-76d0-b75b-c852d46847e0"), true);
  for (const value of [null, 1, "", "../session", "019ff6a4-2797-76d0-b75b-c852d46847e0/extra"]) {
    assert.equal(isValidDeepLinkSessionMessage(value), false);
  }
});
