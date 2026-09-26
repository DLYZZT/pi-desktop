import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { DirectoryRefreshCoordinator } from "./directory-refresh.ts";

function fixture(t) {
  const requests = [],
    values = [],
    errors = [],
    loading = [];
  let invalidations = 0;
  const queue = new DirectoryRefreshCoordinator({
    read() {
      const next = createDeferred();
      requests.push(next);
      return next.promise;
    },
    apply: (value) => values.push(value),
    onError: (error) => errors.push(error),
    onLoading: (value) => loading.push(value),
    onInvalidate: () => invalidations++,
  });
  t.after(() => queue.dispose());
  return {
    queue,
    requests,
    values,
    errors,
    loading,
    get invalidations() {
      return invalidations;
    },
  };
}

test("collapsed directories defer invalidations and refresh once on expansion", async (t) => {
  const { queue, requests, values } = fixture(t);
  await queue.invalidate();
  assert.equal(requests.length, 0);
  const initial = queue.setEnabled(true);
  await Promise.resolve();
  requests[0].resolve("initial");
  await initial;
  await queue.setEnabled(false);
  await queue.invalidate();
  await queue.invalidate();
  assert.equal(requests.length, 1);
  const reopened = queue.setEnabled(true);
  await Promise.resolve();
  requests[1].resolve("fresh");
  await reopened;
  await queue.setEnabled(true);
  assert.equal(requests.length, 2);
  assert.deepEqual(values, ["initial", "fresh"]);
});

test("refreshes during the first read serialize into one new read without publishing stale entries", async (t) => {
  const { queue, requests, values, loading } = fixture(t);
  const reading = queue.setEnabled(true);
  await Promise.resolve();
  assert.equal(queue.invalidate(), reading);
  queue.invalidate();
  assert.equal(requests.length, 1);
  requests[0].resolve("obsolete");
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.deepEqual(values, []);
  requests[1].resolve("current");
  await reading;
  assert.deepEqual(values, ["current"]);
  assert.deepEqual(loading, [true, false]);
});

test("collapsing an invalidated in-flight directory postpones the follow-up until expansion", async (t) => {
  const { queue, requests, values } = fixture(t);
  const reading = queue.setEnabled(true);
  await Promise.resolve();
  queue.setEnabled(false);
  queue.invalidate();
  requests[0].resolve("obsolete");
  await reading;
  assert.equal(requests.length, 1);
  assert.deepEqual(values, []);
  const reopened = queue.setEnabled(true);
  await Promise.resolve();
  requests[1].resolve("fresh");
  await reopened;
  assert.deepEqual(values, ["fresh"]);
});

test("a failed directory read can retry on expansion without creating an automatic retry loop", async (t) => {
  const { queue, requests, errors, values } = fixture(t);
  const reading = queue.setEnabled(true);
  await Promise.resolve();
  const failure = new Error("Directory removed");
  requests[0].reject(failure);
  await reading;
  assert.deepEqual(errors, [failure]);
  assert.equal(requests.length, 1);
  await queue.setEnabled(false);
  const reopened = queue.setEnabled(true);
  await Promise.resolve();
  requests[1].resolve("restored");
  await reopened;
  assert.deepEqual(values, ["restored"]);
});

test("disposed directory owners ignore late success and failure and cannot restart", async (t) => {
  for (const failed of [false, true]) {
    const { queue, requests, values, errors, loading } = fixture(t);
    const reading = queue.setEnabled(true);
    await Promise.resolve();
    queue.dispose();
    if (failed) requests[0].reject(new Error("late"));
    else requests[0].resolve("late");
    await reading;
    await queue.invalidate();
    await queue.setEnabled(true);
    assert.deepEqual(values, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(loading, [true]);
    assert.equal(requests.length, 1);
  }
});
