import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
const { HostManager } = await importTestBundle("host-stop-grace", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "host-manager.ts")],
  plugins: [
    {
      name: "electron-fixture",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "host-stop" }));
        build.onLoad({ filter: /.*/, namespace: "host-stop" }, () => ({
          loader: "js",
          contents:
            'export const app={isPackaged:false,getPath:()=>"/fixture"};export const utilityProcess={};export class MessageChannelMain{}',
        }));
      },
    },
  ],
});
test("normal Host stop waits for exit and allows the SDK refresh deadline before bounded termination", async (t) => {
  const original = globalThis.setTimeout,
    timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      unref() {
        return this;
      },
    };
    timers.push(timer);
    return timer;
  };
  t.after(() => {
    globalThis.setTimeout = original;
  });
  const manager = new HostManager("fixture"),
    exit = createDeferred(),
    messages = [];
  let killed = 0;
  const child = {
    postMessage: (message) => messages.push(message),
    kill: () => {
      killed++;
    },
  };
  manager.child = child;
  manager.childExitSignal = { promise: exit.promise };
  let finished = false;
  const stop = manager.stop().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(killed, 0);
  assert.deepEqual(messages, [{ type: "shutdown" }]);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 15000 && timers[0].delay <= 60000);
  timers[0].callback();
  assert.equal(killed, 1);
  manager.child = undefined;
  exit.resolve();
  await stop;
  timers[0].callback();
  assert.equal(killed, 1);
});
