import assert from "node:assert/strict";
import test from "node:test";
import { restartHostAfterExit } from "./host-install-recovery.ts";

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

test("restarts a Host only after its previous child exits", async () => {
  const exit = deferred();
  const events = [];
  const host = {
    stop: () => {
      events.push("stop");
      return exit.promise;
    },
    start: () => events.push("start"),
  };

  const recovery = restartHostAfterExit(host, () => true);
  await Promise.resolve();
  assert.deepEqual(events, ["stop"]);
  exit.resolve();
  assert.equal(await recovery, true);
  assert.deepEqual(events, ["stop", "start"]);
});

test("does not restart when the application resumed quitting while waiting", async () => {
  const host = { stop: async () => undefined, start: () => assert.fail("unexpected Host restart") };
  assert.equal(await restartHostAfterExit(host, () => false), false);
});
