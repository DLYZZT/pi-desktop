import assert from "node:assert/strict";
import fs from "node:fs";
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

test("ChatInput passes signals and gates file suggestion result, error, and settlement", () => {
  const source = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /fileSuggestionRequestRef\.current/);
  assert.match(source, /const request = requests\.begin\(\)/);
  assert.match(source, /signal: request\.signal/);
  assert.match(source, /requests\.isCurrent\(request\.generation\)/);
  assert.match(source, /requests\.finish\(request\.generation\)/);
  assert.match(source, /atSuggestionState\.tokenKey === atTokenKey/);
});
