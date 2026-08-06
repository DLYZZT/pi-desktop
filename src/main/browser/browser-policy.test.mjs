import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultBrowserSettings } from "./browser-settings.ts";
import { BrowserConfirmationManager } from "./browser-confirmation.ts";
import { BrowserPolicyEngine, createDisabledAdvancedRuntimePolicy } from "./browser-policy.ts";

function enabledSettings() {
  const settings = createDefaultBrowserSettings();
  settings.automation.enabled = true;
  return settings;
}

test("browser capability leases are session-bound, permission-ranked, and invalidated by policy revisions", () => {
  let now = 1_000;
  let id = 0;
  const policy = new BrowserPolicyEngine(enabledSettings(), {
    now: () => now,
    createId: () => `lease-${++id}`,
    grantTtlMs: 10_000,
    leaseTtlMs: 5_000,
  });

  assert.throws(
    () => policy.issueLease("session-a"),
    (error) => error.code === "CAPABILITY_DISABLED",
  );
  const lease = policy.grantSession({ sessionId: "session-a", permission: "read", source: "local" });
  assert.ok(lease);
  const context = {
    sessionId: "session-a",
    capabilityLeaseId: lease.id,
    policyRevision: lease.policyRevision,
    requestId: "request-1",
  };
  assert.equal(policy.assertRequest(context, "read").permission, "read");
  assert.throws(
    () => policy.assertRequest(context, "interact"),
    (error) => error.code === "CAPABILITY_DISABLED",
  );
  assert.throws(
    () => policy.assertRequest({ ...context, sessionId: "session-b" }, "read"),
    (error) => error.code === "CAPABILITY_LEASE_EXPIRED",
  );

  policy.updateSettings({ ...enabledSettings(), navigation: { ...enabledSettings().navigation, allowHttp: true } });
  assert.throws(
    () => policy.assertRequest(context, "read"),
    (error) => error.code === "POLICY_REVISION_MISMATCH",
  );

  const replacement = policy.issueLease("session-a");
  now = replacement.expiresAt + 1;
  assert.throws(
    () =>
      policy.assertRequest(
        {
          sessionId: "session-a",
          capabilityLeaseId: replacement.id,
          policyRevision: replacement.policyRevision,
          requestId: "request-2",
        },
        "read",
      ),
    (error) => error.code === "CAPABILITY_LEASE_EXPIRED",
  );
});

test("channel access and Advanced Browser Mode are gated without a second hidden advanced-channel switch", () => {
  const settings = enabledSettings();
  const policy = new BrowserPolicyEngine(settings, { createId: () => "lease" });
  assert.throws(
    () => policy.grantSession({ sessionId: "channel", permission: "read", source: "channel" }),
    (error) => error.code === "CAPABILITY_DISABLED",
  );
  assert.throws(
    () => policy.grantSession({ sessionId: "local", permission: "advanced", source: "local" }),
    (error) => error.code === "ADVANCED_CONFIRMATION_REQUIRED",
  );

  const advanced = enabledSettings();
  advanced.advancedBrowserMode.enabled = true;
  policy.updateSettings(advanced);
  const lease = policy.grantSession({ sessionId: "local", permission: "advanced", source: "local" });
  assert.equal(lease?.permission, "advanced");

  advanced.automation.allowChannelSessions = true;
  policy.updateSettings(advanced);
  const channelLease = policy.grantSession({
    sessionId: "approved-channel",
    permission: "advanced",
    source: "channel",
  });
  assert.equal(channelLease?.permission, "advanced");

  policy.updateSettings(enabledSettings());
  assert.equal(policy.getSnapshot().sessionPermissions.local, "interact");
});

test("advanced runtime policy is atomic and fail closed", () => {
  const disabled = new BrowserPolicyEngine(enabledSettings());
  assert.deepEqual(disabled.getAdvancedRuntimePolicy(), createDisabledAdvancedRuntimePolicy());

  const settings = enabledSettings();
  settings.advancedBrowserMode.enabled = true;
  settings.advancedBrowserMode.certificateBypassDomains = ["example.com"];
  const enabled = new BrowserPolicyEngine(settings);
  assert.deepEqual(enabled.getAdvancedRuntimePolicy(), {
    enabled: true,
    removeSiteSecurityHeaders: true,
    disableWebSecurity: true,
    allowInsecureContent: true,
    certificateBypassDomains: ["example.com"],
    unrestrictedRawCdp: true,
  });
});

test("confirmation proofs are payload-bound, one-time, and expiring", () => {
  let now = 100;
  const confirmations = new BrowserConfirmationManager({ now: () => now, createId: () => "proof", ttlMs: 50 });
  const payload = { advancedBrowserMode: { enabled: true } };
  const proof = confirmations.issue("advanced-browser-mode", payload);
  assert.throws(
    () => confirmations.consume(proof, "advanced-browser-mode", { advancedBrowserMode: { enabled: false } }),
    (error) => error.code === "ADVANCED_BROWSER_MODE_REQUIRED",
  );
  confirmations.consume(proof, "advanced-browser-mode", payload);
  assert.throws(
    () => confirmations.consume(proof, "advanced-browser-mode", payload),
    (error) => error.code === "ADVANCED_BROWSER_MODE_REQUIRED",
  );

  const replayProof = confirmations.issue("request-replay", { requestId: "r1" });
  now = replayProof.expiresAt;
  assert.throws(
    () => confirmations.consume(replayProof, "request-replay", { requestId: "r1" }),
    (error) => error.code === "REQUEST_REPLAY_CONFIRMATION_REQUIRED",
  );
});
