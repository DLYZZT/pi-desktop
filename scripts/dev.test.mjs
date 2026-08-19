import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";

import { superviseRestartableProcess, waitForViteReady } from "./dev.mjs";

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

test("Electron supervisor debounces rebuilds and starts a replacement after exit", () => {
  const children = [];
  const stopped = [];
  const timers = new Map();
  let nextTimerId = 0;
  const supervisor = superviseRestartableProcess({
    start: () => {
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    stop: (child) => stopped.push(child),
    onUnexpectedExit: () => assert.fail("planned restart was treated as an unexpected exit"),
    setTimer: (callback) => {
      nextTimerId += 1;
      timers.set(nextTimerId, callback);
      return nextTimerId;
    },
    clearTimer: (timerId) => timers.delete(timerId),
  });

  supervisor.scheduleRestart();
  supervisor.scheduleRestart();
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.deepEqual(stopped, [children[0]]);
  children[0].emit("exit", 1, null);
  assert.equal(children.length, 2);
  supervisor.dispose();
});

test("Electron supervisor reports an unplanned exit", () => {
  const child = new EventEmitter();
  let exitResult;
  const supervisor = superviseRestartableProcess({
    start: () => child,
    stop: () => assert.fail("stop should not run"),
    onUnexpectedExit: (result) => {
      exitResult = result;
    },
  });

  child.emit("exit", 7, null);
  assert.deepEqual(exitResult, { code: 7, signal: null });
  supervisor.dispose();
});
