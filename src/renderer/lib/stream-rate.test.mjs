import { importTestBundle } from "#test-bundle";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { createStreamRateState, estimateTokens, resetStreamRate, updateStreamRate } = await importTestBundle(
  "src/renderer/lib/stream-rate",
  { entryPoints: [path.join(import.meta.dirname, "stream-rate.ts")] },
);

test("estimateTokens divides characters by four", () => {
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(0), 0);
});

test("returns null until the window spans at least one second", () => {
  const state = createStreamRateState();
  assert.equal(updateStreamRate(state, 0, 100), null);
  // Second sample inside 1s: no trustworthy span yet.
  assert.equal(updateStreamRate(state, 500, 150), null);
  // At t=1000 the span reaches exactly 1s: 100 tokens over 1s.
  assert.equal(updateStreamRate(state, 1000, 200), 100);
  // Same average rate as more samples arrive.
  assert.equal(updateStreamRate(state, 1500, 250), 100);
});

test("rate reflects only the sliding window, not the cumulative total", () => {
  const state = createStreamRateState();
  updateStreamRate(state, 0, 0);
  updateStreamRate(state, 1000, 400);
  // Slow trickle for a while, then a burst.
  updateStreamRate(state, 5000, 500);
  updateStreamRate(state, 6000, 900);
  // Cumulative average would be 900/6 = 150; the window sees the burst.
  assert.equal(updateStreamRate(state, 7000, 1300), 400);
});

test("remounting mid-stream cannot spike the rate", () => {
  // Old instance accumulated 3200 tokens, then the component unmounts
  // (session switch) and a new one mounts with the full content visible.
  const state = createStreamRateState();
  assert.equal(updateStreamRate(state, 0, 3200), null);
  // Tokens keep arriving in the background; the new instance only counts
  // the growth it observed itself.
  assert.equal(updateStreamRate(state, 1000, 3400), 200);
  assert.equal(updateStreamRate(state, 2000, 3600), 200);
});

test("a shrinking token count restarts the window", () => {
  const state = createStreamRateState();
  updateStreamRate(state, 0, 1000);
  updateStreamRate(state, 1000, 1200);
  // Stream restarted: content collapsed back to a small size.
  assert.equal(updateStreamRate(state, 2000, 50), null);
  // Fresh window: 200 tokens over the 1s span since the restart.
  assert.equal(updateStreamRate(state, 3000, 250), 200);
});

test("idle streams hide the badge instead of showing near-zero noise", () => {
  const state = createStreamRateState();
  updateStreamRate(state, 0, 600);
  // Half a token per second is below the 0.5 t/s floor.
  assert.equal(updateStreamRate(state, 2000, 601), null);
  assert.equal(updateStreamRate(state, 4000, 602), null);
});

test("resetStreamRate drops all samples", () => {
  const state = createStreamRateState();
  updateStreamRate(state, 0, 100);
  updateStreamRate(state, 1000, 200);
  resetStreamRate(state);
  assert.equal(updateStreamRate(state, 2000, 300), null);
});
