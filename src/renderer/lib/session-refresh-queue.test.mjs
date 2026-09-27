import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { SessionRefreshQueue } from "./session-refresh-queue.ts";

function fixture(read) {
  const callbacks = new Map();
  let next = 0;
  const queue = new SessionRefreshQueue(read, (run, delay) => {
    const id = ++next;
    callbacks.set(id, { run, delay });
    return () => callbacks.delete(id);
  });
  return {
    queue,
    callbacks,
    async tick() {
      const [id, value] = callbacks.entries().next().value;
      callbacks.delete(id);
      await value.run();
    },
  };
}

test("file-change bursts become one read and changes during that read become one trailing read", async () => {
  const first = createDeferred();
  let reads = 0;
  const f = fixture(() => (++reads === 1 ? first.promise : Promise.resolve()));
  for (let i = 0; i < 100; i++) f.queue.request(1000);
  assert.equal(f.callbacks.size, 1);
  const running = f.tick();
  assert.equal(reads, 1);
  for (let i = 0; i < 100; i++) f.queue.request(1000);
  assert.equal(f.callbacks.size, 0);
  first.resolve();
  await running;
  assert.equal(f.callbacks.size, 1);
  await f.tick();
  assert.equal(reads, 2);
  f.queue.dispose();
});

test("urgent reconciliation bypasses a delay and completion cancels redundant reads", async () => {
  let reads = 0;
  const f = fixture(() => reads++);
  f.queue.request(1000);
  f.queue.request(0);
  assert.equal(reads, 1);
  assert.equal(f.callbacks.size, 0);
  await Promise.resolve();
  f.queue.request(1000);
  f.queue.cancel();
  assert.equal(f.callbacks.size, 0);
  f.queue.dispose();
  f.queue.request(0);
  assert.equal(reads, 1);
});

test("disposing a view prevents a trailing refresh after an in-flight read settles", async () => {
  const pending = createDeferred();
  const f = fixture(() => pending.promise);
  f.queue.request(0);
  f.queue.request(1000);
  f.queue.dispose();
  pending.resolve();
  await Promise.resolve();
  assert.equal(f.callbacks.size, 0);
});
