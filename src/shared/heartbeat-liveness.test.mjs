import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHeartbeatTick } from "./heartbeat-liveness.ts";

const intervalMs = 15_000;
const timeoutMs = 10_000;

test("heartbeat remains healthy while ticks and acknowledgements are current", () => {
  assert.deepEqual(
    evaluateHeartbeatTick({
      now: 30_000,
      lastTickAt: 15_000,
      lastAcknowledgedAt: 15_100,
      intervalMs,
      timeoutMs,
    }),
    { timedOut: false, clockDiscontinuity: false },
  );
});

test("heartbeat times out only when the local timer kept running", () => {
  assert.deepEqual(
    evaluateHeartbeatTick({
      now: 45_001,
      lastTickAt: 30_001,
      lastAcknowledgedAt: 20_000,
      intervalMs,
      timeoutMs,
    }),
    { timedOut: true, clockDiscontinuity: false },
  );
});

test("sleep, event-loop stalls, and wall-clock rollback re-establish the heartbeat baseline", () => {
  assert.deepEqual(
    evaluateHeartbeatTick({
      now: 60_001,
      lastTickAt: 30_000,
      lastAcknowledgedAt: 30_100,
      intervalMs,
      timeoutMs,
    }),
    { timedOut: false, clockDiscontinuity: true },
  );
  assert.deepEqual(
    evaluateHeartbeatTick({
      now: 5_000,
      lastTickAt: 10_000,
      lastAcknowledgedAt: 10_100,
      intervalMs,
      timeoutMs,
    }),
    { timedOut: false, clockDiscontinuity: true },
  );
});
