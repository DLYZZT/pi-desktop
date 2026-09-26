import assert from "node:assert/strict";
import test from "node:test";
import { abortableDelay } from "./abortable-delay.ts";

test("aborting a polling wait clears its timer and settles it without waiting for the interval", async (t) => {
  const timers = new Map();
  let sequence = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const controller = new globalThis.AbortController();
  const pending = abortableDelay(800, controller.signal);
  assert.equal(timers.size, 1);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(timers.size, 0);
  assert.equal(await abortableDelay(600, controller.signal), false);
  assert.equal(timers.size, 0);
});

test("an elapsed wait releases its abort listener and reports completion", async (t) => {
  let callback,
    clears = 0,
    removed = 0;
  t.mock.method(globalThis, "setTimeout", (handler) => {
    callback = handler;
    return 1;
  });
  t.mock.method(globalThis, "clearTimeout", () => clears++);
  const controller = new globalThis.AbortController();
  const original = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "removeEventListener", (...args) => {
    removed++;
    return original(...args);
  });
  const pending = abortableDelay(600, controller.signal);
  callback();
  assert.equal(await pending, true);
  controller.abort();
  assert.equal(clears, 1);
  assert.equal(removed, 1);
});
