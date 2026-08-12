import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowShowFallback } from "./window-show-fallback.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ready-to-show wins once and clears the fallback timer", async () => {
  const window = new EventEmitter();
  let shows = 0;
  installWindowShowFallback(window, () => (shows += 1), 10);

  window.emit("ready-to-show");
  await wait(20);
  assert.equal(shows, 1);
  assert.equal(window.listenerCount("hide"), 0);
});

test("hide, close, and closed cancel both ready and fallback show paths", async () => {
  for (const event of ["hide", "close", "closed"]) {
    const window = new EventEmitter();
    let shows = 0;
    installWindowShowFallback(window, () => (shows += 1), 10);

    window.emit(event);
    window.emit("ready-to-show");
    await wait(20);
    assert.equal(shows, 0, `${event} must suppress a later show`);
    assert.equal(window.listenerCount("ready-to-show"), 0);
  }
});
