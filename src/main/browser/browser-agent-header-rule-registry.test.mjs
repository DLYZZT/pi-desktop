import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAgentHeaderRuleRegistry } from "./browser-agent-header-rule-registry.ts";

function rule(id, secretRef) {
  return {
    id,
    enabled: true,
    profileId: "profile",
    urlPattern: "https://example.test/*",
    header: "authorization",
    operation: "set",
    ...(secretRef ? { secretRef } : { value: id }),
  };
}

test("scopes Agent header rules by owner session and never restores them in a new registry", () => {
  const registry = new BrowserAgentHeaderRuleRegistry();
  registry.set("profile", "request", "session-a", [rule("a", "browser-secret-a1234567")]);
  registry.set("profile", "request", "session-b", [rule("b")]);

  assert.deepEqual(
    registry.get("profile", "request").map(({ id, source, ownerSessionId }) => ({ id, source, ownerSessionId })),
    [
      { id: "a", source: "agent", ownerSessionId: "session-a" },
      { id: "b", source: "agent", ownerSessionId: "session-b" },
    ],
  );
  const removed = registry.clearSession("session-a");
  assert.deepEqual(
    removed.rules.map(({ id }) => id),
    ["a"],
  );
  assert.deepEqual(removed.scopes, [{ profileId: "profile", direction: "request" }]);
  assert.deepEqual(
    registry.get("profile", "request").map(({ id }) => id),
    ["b"],
  );
  assert.equal(registry.hasSecretRef("browser-secret-a1234567"), false);
  assert.deepEqual(new BrowserAgentHeaderRuleRegistry().get("profile", "request"), []);
});

test("retains a shared secret reference until its last Agent owner is cleared", () => {
  const registry = new BrowserAgentHeaderRuleRegistry();
  const secretRef = "browser-secret-shared12";
  registry.set("profile", "request", "session-a", [rule("a", secretRef)]);
  registry.set("profile", "request", "session-b", [rule("b", secretRef)]);

  registry.clearSession("session-a");
  assert.equal(registry.hasSecretRef(secretRef), true);
  registry.clearSession("session-b");
  assert.equal(registry.hasSecretRef(secretRef), false);
});

test("replacing one owner cannot exceed the shared scope limit", () => {
  const registry = new BrowserAgentHeaderRuleRegistry();
  registry.set(
    "profile",
    "response",
    "session-a",
    Array.from({ length: 60 }, (_, index) => rule(`a-${index}`)),
  );
  registry.set(
    "profile",
    "response",
    "session-b",
    Array.from({ length: 40 }, (_, index) => rule(`b-${index}`)),
  );
  assert.throws(
    () =>
      registry.set(
        "profile",
        "response",
        "session-b",
        Array.from({ length: 41 }, (_, index) => rule(`c-${index}`)),
      ),
    (error) => error.code === "INVALID_BROWSER_REQUEST",
  );
  assert.equal(registry.get("profile", "response").length, 100);
});
