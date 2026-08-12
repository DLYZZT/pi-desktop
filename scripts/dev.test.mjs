import assert from "node:assert/strict";
import test from "node:test";

import { waitForViteReady } from "./dev.mjs";

test("Vite readiness retries failures until an OK health response", async () => {
  let clock = 0;
  let calls = 0;
  await waitForViteReady("http://127.0.0.1:5173", {
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return { ok: calls === 3, status: 503 };
    },
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
    timeoutMs: 1_000,
    intervalMs: 100,
  });
  assert.equal(calls, 3);
  assert.equal(clock, 200);
});

test("Vite readiness has a total timeout with the last failure", async () => {
  let clock = 0;
  await assert.rejects(
    waitForViteReady("http://127.0.0.1:5173", {
      fetch: async () => ({ ok: false, status: 503 }),
      now: () => clock,
      sleep: async (delay) => {
        clock += delay;
      },
      timeoutMs: 250,
      intervalMs: 100,
    }),
    /within 250ms \(last failure: HTTP 503\)/,
  );
  assert.equal(clock, 250);
});
