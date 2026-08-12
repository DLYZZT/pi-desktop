import assert from "node:assert/strict";
import test from "node:test";

import { connectTimedEventStream, EventStreamConnectionManager } from "./event-stream-connection.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a subscription resolving after timeout is immediately closed and cannot emit", async () => {
  const target = { current: null };
  const manager = new EventStreamConnectionManager(target);
  const pending = deferred();
  let closed = 0;
  let received = 0;
  let listener;
  const resultPromise = connectTimedEventStream({
    manager,
    subscribe(onEvent) {
      listener = onEvent;
      return pending.promise;
    },
    onEvent() {
      received += 1;
    },
    timeoutMs: 1,
  });

  const result = await resultPromise;
  assert.equal(result.status, "timeout");
  pending.resolve(() => {
    closed += 1;
  });
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));
  listener({ type: "ghost" });
  assert.equal(closed, 1);
  assert.equal(received, 0);
  assert.equal(target.current, null);
});

test("a late old connection cannot overwrite or close its replacement", async () => {
  const target = { current: null };
  const manager = new EventStreamConnectionManager(target);
  const oldPending = deferred();
  let oldClosed = 0;
  let newClosed = 0;

  const oldConnection = connectTimedEventStream({
    manager,
    subscribe: () => oldPending.promise,
    onEvent() {},
    timeoutMs: 1_000,
  });
  const newConnection = await connectTimedEventStream({
    manager,
    subscribe: async () => () => {
      newClosed += 1;
    },
    onEvent() {},
    timeoutMs: 1_000,
  });
  assert.equal(newConnection.status, "connected");
  const current = target.current;

  oldPending.resolve(() => {
    oldClosed += 1;
  });
  assert.equal((await oldConnection).status, "closed");
  assert.equal(oldClosed, 1);
  assert.equal(newClosed, 0);
  assert.equal(target.current, current);

  newConnection.unsubscribe();
  assert.equal(newClosed, 1);
  assert.equal(target.current, null);
});
