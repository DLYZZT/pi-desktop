import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createManualScheduler } from "#test-timing";
import { installWindowShowFallback } from "./window-show-fallback.ts";

test("ready-to-show wins once and clears the fallback timer", () => {
  const window = new EventEmitter();
  const scheduler = createManualScheduler();
  let shows = 0;
  installWindowShowFallback(window, () => (shows += 1), 10, scheduler);

  window.emit("ready-to-show");
  assert.equal(shows, 1);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(window.listenerCount("hide"), 0);
});

test("hide, close, and closed cancel both ready and fallback show paths", () => {
  for (const event of ["hide", "close", "closed"]) {
    const window = new EventEmitter();
    const scheduler = createManualScheduler();
    let shows = 0;
    installWindowShowFallback(window, () => (shows += 1), 10, scheduler);

    window.emit(event);
    window.emit("ready-to-show");
    assert.equal(shows, 0, `${event} must suppress a later show`);
    assert.equal(scheduler.pendingCount(), 0);
    assert.equal(window.listenerCount("ready-to-show"), 0);
  }
});

test("fallback shows exactly once when its injected deadline fires", async () => {
  const window = new EventEmitter();
  const scheduler = createManualScheduler();
  let shows = 0;
  installWindowShowFallback(window, () => (shows += 1), 3_000, scheduler);

  await scheduler.runNext();
  window.emit("ready-to-show");
  assert.equal(shows, 1);
  assert.equal(scheduler.pendingCount(), 0);
});
