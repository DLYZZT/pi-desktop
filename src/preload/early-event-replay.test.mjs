import assert from "node:assert/strict";
import test from "node:test";

import { EarlyEventReplay } from "./early-event-replay.ts";

test("an early event replays consistently to every subscriber within its generation", () => {
  let now = 100;
  const replay = new EarlyEventReplay(1_000, () => now);
  const received = [];
  replay.emit("first");

  const offA = replay.subscribe((value) => received.push(["a", value]));
  const offB = replay.subscribe((value) => received.push(["b", value]));
  assert.deepEqual(received, [
    ["a", "first"],
    ["b", "first"],
  ]);

  replay.emit("live");
  assert.deepEqual(received.slice(-2), [
    ["a", "live"],
    ["b", "live"],
  ]);
  offA();
  offB();

  replay.emit("replacement");
  replay.emit("latest");
  replay.subscribe((value) => received.push(["c", value]));
  assert.deepEqual(received.at(-1), ["c", "latest"]);

  now += 1_001;
  replay.subscribe((value) => received.push(["expired", value]));
  assert.equal(
    received.some(([name]) => name === "expired"),
    false,
  );
});

test("listener failures do not block live delivery or replay", () => {
  const replay = new EarlyEventReplay();
  replay.emit("early");
  assert.doesNotThrow(() =>
    replay.subscribe(() => {
      throw new Error("early listener");
    }),
  );

  const received = [];
  replay.subscribe((value) => received.push(value));
  replay.emit("live");
  assert.deepEqual(received, ["early", "live"]);
});
