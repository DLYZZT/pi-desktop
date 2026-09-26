import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { abortableDelay, withTimeout } from "./browser-action-timing.ts";

function scheduler(t) {
  const timers = new Map();
  let sequence = 0;
  t.mock.method(globalThis, "setTimeout", (callback) => {
    const id = ++sequence;
    timers.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  return {
    timers,
    fire() {
      for (const callback of [...timers.values()]) callback();
    },
  };
}

test("a previously cancelled Browser delay rejects without retaining a timer", async (t) => {
  const clock = scheduler(t),
    controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(abortableDelay(100, controller.signal), (error) => error.code === "USER_TOOK_CONTROL");
  assert.equal(clock.timers.size, 0);
});

test("normal completion and cancellation both release Browser delay listeners", async (t) => {
  const clock = scheduler(t),
    controller = new globalThis.AbortController();
  let removals = 0;
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "removeEventListener", (...args) => {
    removals++;
    return remove(...args);
  });
  const first = abortableDelay(100, controller.signal);
  clock.fire();
  await first;
  assert.equal(removals, 1);
  assert.equal(clock.timers.size, 0);
  const second = abortableDelay(100, controller.signal);
  const cancelled = assert.rejects(second, (error) => error.code === "USER_TOOK_CONTROL");
  controller.abort();
  await cancelled;
  assert.equal(clock.timers.size, 0);
  assert.equal(removals, 2);
});

test("Browser timeout distinguishes deadlines and consumes a late rejected action after cancellation", async (t) => {
  const clock = scheduler(t),
    slow = createDeferred();
  const first = withTimeout(slow.promise, 10, "JAVASCRIPT_TIMEOUT");
  const timedOut = assert.rejects(first, (error) => error.code === "JAVASCRIPT_TIMEOUT" && error.retryable === true);
  clock.fire();
  await timedOut;
  slow.resolve();
  const pending = createDeferred(),
    controller = new globalThis.AbortController();
  const second = withTimeout(pending.promise, 10, "ACTION_TIMEOUT", controller.signal);
  const cancelled = assert.rejects(second, (error) => error.code === "USER_TOOK_CONTROL");
  controller.abort();
  await cancelled;
  pending.reject(new Error("late provider failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.timers.size, 0);
});
