import assert from "node:assert/strict";
import test from "node:test";

import { BrowserError } from "./browser-error.ts";

test("Browser errors always expose stable recovery semantics", () => {
  const stale = new BrowserError("STALE_ELEMENT_REF", "stale").toJSON();
  assert.deepEqual(stale.recovery, {
    retryable: false,
    reason: "stale-state",
    remediation: "refresh-inspection",
  });
  assert.equal(stale.retryable, false);

  const navigation = new BrowserError("NAVIGATION_FAILED", "failed", {
    details: { netError: "ERR_NAME_NOT_RESOLVED" },
  }).toJSON();
  assert.equal(navigation.retryable, true);
  assert.equal(navigation.recovery.remediation, "wait-and-retry-once");
  assert.equal(navigation.details.netError, "ERR_NAME_NOT_RESOLVED");

  const policy = new BrowserError("PRIVATE_NETWORK_BLOCKED", "blocked").toJSON();
  assert.equal(policy.retryable, false);
  assert.equal(policy.recovery.remediation, "request-local-network-authorization");

  const javascript = new BrowserError("JAVASCRIPT_EXECUTION_FAILED", "syntax error").toJSON();
  assert.deepEqual(javascript.recovery, {
    retryable: false,
    reason: "invalid-input",
    remediation: "change-input",
  });
});
