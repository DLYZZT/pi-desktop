import assert from "node:assert/strict";
import test from "node:test";
import { runTerminalControlFlow } from "./terminal-control-flow.ts";

test("terminal control first attempts non-takeover and asks again only when busy", async () => {
  const attempts = [];
  let confirmations = 0;
  let busy = 0;
  const result = await runTerminalControlFlow({
    confirmInitial: () => {
      confirmations += 1;
      return true;
    },
    confirmTakeover: () => {
      confirmations += 1;
      return true;
    },
    openControl: async (takeover) => {
      attempts.push(takeover);
      return takeover ? undefined : "HERDR_TERMINAL_BUSY";
    },
    restoreObserve: async () => assert.fail("takeover acceptance must not restore observe"),
    onBusy: () => {
      busy += 1;
    },
  });
  assert.equal(result, "opened");
  assert.deepEqual(attempts, [false, true]);
  assert.equal(confirmations, 2);
  assert.equal(busy, 1);
});

test("declining takeover restores observe and non-busy failures never request takeover", async () => {
  let restored = 0;
  const busy = await runTerminalControlFlow({
    confirmInitial: () => true,
    confirmTakeover: () => false,
    openControl: async () => "HERDR_TERMINAL_BUSY",
    restoreObserve: async () => {
      restored += 1;
    },
  });
  assert.equal(busy, "cancelled");
  assert.equal(restored, 1);

  let takeoverAsked = false;
  const failed = await runTerminalControlFlow({
    confirmInitial: () => true,
    confirmTakeover: () => {
      takeoverAsked = true;
      return true;
    },
    openControl: async () => "HERDR_ENDPOINT_UNAVAILABLE",
    restoreObserve: async () => undefined,
  });
  assert.equal(failed, "failed");
  assert.equal(takeoverAsked, false);
});
