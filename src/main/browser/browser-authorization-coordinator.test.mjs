import assert from "node:assert/strict";
import test from "node:test";

import { BrowserAuthorizationCoordinator } from "./browser-authorization-coordinator.ts";

function fixture(options = {}) {
  let permission = options.permission ?? "ask";
  let nextId = 0;
  const requests = [];
  const resolved = [];
  const grants = [];
  const coordinator = new BrowserAuthorizationCoordinator({
    getPersistentPermission: () => permission,
    isRendererAvailable: () => options.rendererAvailable !== false,
    grant: (...args) => {
      options.grant?.(...args);
      grants.push(args);
    },
    emitRequest: (request) => requests.push(request),
    emitResolved: (...args) => resolved.push(args),
    createId: () => `request-${++nextId}`,
    timeoutMs: options.timeoutMs ?? 1_000,
    denyCooldownMs: options.denyCooldownMs ?? 1_000,
    maxDeniedCooldowns: options.maxDeniedCooldowns,
    now: options.now,
  });
  return {
    coordinator,
    requests,
    resolved,
    grants,
    setPermission(value) {
      permission = value;
    },
  };
}

test("persistent policy grants without prompting and explicit deny fails closed", async () => {
  const allowed = fixture({ permission: "interact" });
  await allowed.coordinator.request("session", "local", "read");
  assert.equal(allowed.requests.length, 0);
  assert.deepEqual(allowed.grants[0], ["session", "read", "local", "persistent-policy"]);

  const denied = fixture({ permission: "deny" });
  await assert.rejects(denied.coordinator.request("session", "local", "read"), (error) => error.code === "USER_DENIED");
  assert.equal(denied.requests.length, 0);
});

test("same-tier requests coalesce and a session response grants both calls once", async () => {
  const value = fixture();
  const first = value.coordinator.request("session", "local", "read");
  const second = value.coordinator.request("session", "local", "read");
  assert.equal(value.requests.length, 1);
  value.coordinator.respond(value.requests[0].id, "allow-session");
  await Promise.all([first, second]);
  assert.equal(value.grants.length, 1);
  assert.equal(value.resolved[0][1], "allowed-session");
});

test("higher-tier requests queue behind the current dialog and stale responses are rejected", async () => {
  const value = fixture();
  const read = value.coordinator.request("session", "local", "read");
  const advanced = value.coordinator.request("session", "local", "advanced");
  assert.equal(value.requests.length, 1);
  const firstId = value.requests[0].id;
  value.coordinator.respond(firstId, "allow-session");
  await read;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.requests.length, 2);
  assert.throws(
    () => value.coordinator.respond(firstId, "allow-session"),
    (error) => error.code === "INVALID_BROWSER_REQUEST",
  );
  value.coordinator.respond(value.requests[1].id, "allow-session");
  await advanced;
  assert.equal(value.grants.at(-1)[1], "advanced");
});

test("authorization dialogs are globally serialized across sessions", async () => {
  const value = fixture();
  const first = value.coordinator.request("session-a", "local", "read");
  const second = value.coordinator.request("session-b", "channel", "read");
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0].sessionId, "session-a");
  value.coordinator.respond(value.requests[0].id, "allow-session");
  await first;
  assert.equal(value.requests.length, 2);
  assert.equal(value.requests[1].sessionId, "session-b");
  value.coordinator.respond(value.requests[1].id, "allow-session");
  await second;
});

test("settings can resolve a pending request while timeout and unavailable Renderer fail closed", async () => {
  const value = fixture();
  const pending = value.coordinator.request("session", "local", "interact");
  value.setPermission("interact");
  value.coordinator.persistentPolicyChanged("session");
  await pending;
  assert.equal(value.resolved[0][1], "persistent-policy");

  const timed = fixture({ timeoutMs: 10 });
  await assert.rejects(
    timed.coordinator.request("session", "local", "read"),
    (error) => error.code === "AUTHORIZATION_TIMEOUT",
  );

  const unavailable = fixture({ rendererAvailable: false });
  await assert.rejects(
    unavailable.coordinator.request("session", "local", "read"),
    (error) => error.code === "CAPABILITY_DISABLED",
  );
  assert.equal(unavailable.requests.length, 0);
});

test("a prompt grant failure immediately clears pending state and advances the queue", async () => {
  let shouldFail = true;
  const failure = new Error("grant store unavailable");
  const value = fixture({
    grant: () => {
      if (shouldFail) throw failure;
    },
  });
  const first = value.coordinator.request("session-a", "local", "read");
  const second = value.coordinator.request("session-b", "local", "read");

  assert.throws(() => value.coordinator.respond(value.requests[0].id, "allow-session"), failure);
  await assert.rejects(first, failure);
  assert.equal(value.resolved[0][1], "denied");
  assert.deepEqual(
    value.coordinator.listPending().map(({ sessionId }) => sessionId),
    ["session-b"],
  );
  assert.equal(value.requests[1].sessionId, "session-b");

  shouldFail = false;
  value.coordinator.respond(value.requests[1].id, "allow-session");
  await second;
  assert.equal(value.coordinator.listPending().length, 0);
});

test("a persistent-policy grant failure follows the same cleanup rule", async () => {
  const failure = new Error("policy grant failed");
  const value = fixture({
    grant: () => {
      throw failure;
    },
  });
  const pending = value.coordinator.request("session", "local", "interact");
  value.setPermission("interact");

  assert.throws(() => value.coordinator.persistentPolicyChanged("session"), failure);
  await assert.rejects(pending, failure);
  assert.equal(value.resolved[0][1], "denied");
  assert.equal(value.coordinator.listPending().length, 0);
});

test("denial cooldowns expire on read, clear with sessions, and remain bounded", async () => {
  let now = 100;
  const value = fixture({ now: () => now, denyCooldownMs: 50, maxDeniedCooldowns: 2 });

  for (const sessionId of ["session-a", "session-b", "session-c"]) {
    const pending = value.coordinator.request(sessionId, "local", "read");
    value.coordinator.respond(value.requests.at(-1).id, "deny");
    await assert.rejects(pending, (error) => error.code === "USER_DENIED");
  }
  assert.deepEqual([...value.coordinator.deniedUntil.keys()], ["session-b", "session-c"]);

  value.coordinator.cancelSession("session-b");
  assert.deepEqual([...value.coordinator.deniedUntil.keys()], ["session-c"]);

  now += 50;
  const retried = value.coordinator.request("session-c", "local", "read");
  assert.equal(value.coordinator.deniedUntil.has("session-c"), false);
  value.coordinator.cancelSession("session-c");
  await assert.rejects(retried, (error) => error.code === "CAPABILITY_DISABLED");
});
