import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  PendingSessionLoadTraceRegistry,
  beginSessionLoadTrace,
  consumeSessionLoadTrace,
  markSessionLoadPhase,
  finishSessionLoadTrace,
  failSessionLoadTrace,
} from "./session-performance.ts";

function trace(sessionId, startedAt, id = sessionId) {
  return { id, sessionId, source: "selection", startedAt };
}

test("replacing and taking traces clean up the exact pending entry", () => {
  const discarded = [];
  const registry = new PendingSessionLoadTraceRegistry(
    () => 0,
    (entry) => discarded.push(entry.id),
  );
  const first = trace("session", 0, "first");
  const replacement = trace("session", 0, "replacement");

  registry.set(first);
  registry.set(replacement);

  assert.deepEqual(discarded, ["first"]);
  assert.equal(registry.size, 1);
  assert.equal(registry.delete(first), false);
  assert.equal(registry.take("session"), replacement);
  assert.equal(registry.size, 0);
});

test("pending traces enforce TTL and insertion-order capacity", () => {
  let now = 0;
  const discarded = [];
  const registry = new PendingSessionLoadTraceRegistry(
    () => now,
    (entry) => discarded.push(entry.id),
    10,
    2,
  );

  registry.set(trace("a", 0));
  now = 5;
  registry.set(trace("b", 5));
  now = 6;
  registry.set(trace("c", 6));
  assert.deepEqual(discarded, ["a"]);
  assert.equal(registry.size, 2);

  now = 15;
  assert.equal(registry.take("missing"), undefined);
  assert.deepEqual(discarded, ["a", "b"]);
  assert.equal(registry.size, 1);
  assert.equal(registry.take("c")?.id, "c");
});

test("finish and fail paths remove pending ownership and their actual performance marks", () => {
  for (const complete of [finishSessionLoadTrace, failSessionLoadTrace]) {
    const pending = beginSessionLoadTrace("cleanup-fixture", "selection");
    markSessionLoadPhase(pending, "rpc-start");
    assert.ok(performance.getEntriesByType("mark").some((entry) => entry.name.includes(pending.id)));
    complete(pending);
    assert.equal(
      performance.getEntriesByType("mark").some((entry) => entry.name.includes(pending.id)),
      false,
    );
    const replacement = consumeSessionLoadTrace("cleanup-fixture", "initial");
    assert.notEqual(replacement.id, pending.id);
    failSessionLoadTrace(replacement);
  }
});
