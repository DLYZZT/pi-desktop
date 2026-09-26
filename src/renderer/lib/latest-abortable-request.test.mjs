import assert from "node:assert/strict";
import test from "node:test";

import { LatestAbortableRequest } from "./latest-abortable-request.ts";

test("starting a request aborts its predecessor and advances generation", () => {
  const requests = new LatestAbortableRequest();
  const first = requests.begin();
  const second = requests.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(requests.isCurrent(first.generation), false);
  assert.equal(requests.isCurrent(second.generation), true);
  assert.notEqual(first.generation, second.generation);
});

test("old cleanup cannot abort or finish its replacement", () => {
  const requests = new LatestAbortableRequest();
  const first = requests.begin();
  const second = requests.begin();

  assert.equal(requests.cancel(first.generation), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(requests.finish(first.generation), false);
  assert.equal(requests.finish(second.generation), true);
  assert.equal(requests.isCurrent(second.generation), false);
});

test("exact cancellation aborts the signal and prevents stale finally ownership", () => {
  const requests = new LatestAbortableRequest();
  const current = requests.begin();

  assert.equal(requests.cancel(current.generation), true);
  assert.equal(current.signal.aborted, true);
  assert.equal(requests.finish(current.generation), false);
});
