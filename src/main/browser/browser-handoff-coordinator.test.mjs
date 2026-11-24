import assert from "node:assert/strict";
import test from "node:test";

import { BrowserHandoffCoordinator } from "./browser-handoff-coordinator.ts";

function fixture(options = {}) {
  let nextId = 0;
  const requests = [];
  const resolved = [];
  const coordinator = new BrowserHandoffCoordinator({
    isRendererAvailable: () => options.rendererAvailable !== false,
    emitRequest: (request) => requests.push(request),
    emitResolved: (...args) => resolved.push(args),
    createId: () => `handoff-${++nextId}`,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { coordinator, requests, resolved };
}

function input(overrides = {}) {
  return {
    sessionId: "session-1",
    tabId: "tab-1",
    kind: "login",
    origin: "https://example.com",
    title: "Sign in",
    message: "Please sign in",
    ...overrides,
  };
}

test("a handoff is emitted once and resolves with the user decision", async () => {
  const value = fixture();
  const pending = value.coordinator.request(input());
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0].kind, "login");
  assert.equal(value.coordinator.list().length, 1);

  value.coordinator.respond("handoff-1", { outcome: "completed", note: "signed in" });
  const result = await pending;
  assert.equal(result.outcome, "completed");
  assert.equal(result.note, "signed in");
  assert.deepEqual(value.resolved[0], ["handoff-1", "completed"]);
  assert.equal(value.coordinator.list().length, 0);
});

test("a second tab waits for the first handoff to finish", async () => {
  const value = fixture();
  const first = value.coordinator.request(input({ tabId: "tab-1" }));
  const second = value.coordinator.request(input({ tabId: "tab-2" }));
  assert.equal(value.requests.length, 1);

  value.coordinator.respond("handoff-1", { outcome: "cancelled" });
  assert.equal((await first).outcome, "cancelled");
  assert.equal(value.requests.length, 2);
  assert.equal(value.requests[1].tabId, "tab-2");

  value.coordinator.respond("handoff-2", { outcome: "completed" });
  assert.equal((await second).outcome, "completed");
});

test("requests for the same tab join the active handoff", async () => {
  const value = fixture();
  const first = value.coordinator.request(input());
  const second = value.coordinator.request(input({ message: "still waiting" }));
  assert.equal(value.requests.length, 1);

  value.coordinator.respond("handoff-1", { outcome: "completed" });
  assert.equal((await first).outcome, "completed");
  assert.equal((await second).outcome, "completed");
});

test("an unanswered handoff times out without trapping the Agent", async () => {
  const value = fixture();
  const pending = value.coordinator.request(input({ timeoutMs: 20 }));
  const result = await pending;
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(value.resolved[0], ["handoff-1", "timeout"]);
});

test("cancelling a session resolves its pending handoff", async () => {
  const value = fixture();
  const pending = value.coordinator.request(input());
  value.coordinator.cancelSession("session-1");
  assert.equal((await pending).outcome, "cancelled");
});

test("no renderer fails closed before showing a prompt", async () => {
  const value = fixture({ rendererAvailable: false });
  await assert.rejects(value.coordinator.request(input()), (error) => error.code === "CAPABILITY_DISABLED");
  assert.equal(value.requests.length, 0);
});
