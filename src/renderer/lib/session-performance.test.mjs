import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { PendingSessionLoadTraceRegistry } from "./session-performance.ts";

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

test("finish and fail paths both remove pending ownership and clear marks", () => {
  const source = fs.readFileSync(new URL("./session-performance.ts", import.meta.url), "utf8");
  const finish = source.slice(
    source.indexOf("export function finishSessionLoadTrace"),
    source.indexOf("export function failSessionLoadTrace"),
  );
  const fail = source.slice(
    source.indexOf("export function failSessionLoadTrace"),
    source.indexOf("export function logSessionPerformanceEvent"),
  );

  for (const body of [finish, fail]) {
    assert.match(body, /pendingBySession\.delete\(trace\)/);
    assert.match(body, /clearSessionLoadTrace\(trace\)/);
  }
});

test("session hook terminates stale, replaced, and unmounted commit traces", () => {
  const source = fs.readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

  assert.match(source, /sessionIdRef\.current !== sid[\s\S]*failSessionLoadTrace\(trace\)/);
  assert.match(source, /replacedCommitTrace[\s\S]*failSessionLoadTrace\(replacedCommitTrace\)/);
  assert.match(source, /pendingSessionLoadTraceRef\.current = null;[\s\S]*if \(trace\) failSessionLoadTrace\(trace\)/);
});
