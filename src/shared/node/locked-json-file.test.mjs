import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import timers from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { withLockedJsonFile } from "./locked-json-file.ts";

function fixture(t, platform = "win32") {
  const root = mkdtempSync(path.join(tmpdir(), "pi-json-lock-"));
  const filename = path.join(root, "config.json");
  writeFileSync(filename, '{"kept":true}');
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => {
    Object.defineProperty(process, "platform", original);
    rmSync(root, { recursive: true, force: true });
  });
  return filename;
}
const failure = (code) => Object.assign(new Error(code), { code });

test("Windows lock acquisition uses SDK jittered backoff and clamps to the shared deadline", async (t) => {
  const filename = fixture(t),
    delays = [];
  let now = 0,
    attempts = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  t.mock.method(timers, "setTimeout", async (ms) => {
    delays.push(ms);
    now += ms;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(lockfile, "lock", async () => {
    if (++attempts <= 5) throw failure("EPERM");
    return async () => {};
  });
  await withLockedJsonFile(filename, () => {});
  assert.deepEqual(delays, [15, 30, 60, 120, 240]);
  assert.equal(now, 465, "retry window must exceed the old fixed 100ms budget");
  now = 0;
  delays.length = 0;
  t.mock.method(lockfile, "lock", async () => {
    now = Math.max(now, 29_995);
    throw failure("ELOCKED");
  });
  await assert.rejects(
    withLockedJsonFile(filename, () => assert.fail()),
    { code: "ELOCKED" },
  );
  assert.deepEqual(delays, [5]);
  assert.equal(now, 30_000);
});

test("Windows retries five transient EPERMs before one mutation and releases the lock", async (t) => {
  const filename = fixture(t);
  let attempts = 0,
    actions = 0,
    releases = 0;
  t.mock.method(lockfile, "lock", async () => {
    if (++attempts <= 5) throw failure("EPERM");
    return async () => {
      releases++;
    };
  });
  await withLockedJsonFile(filename, async (data, save) => {
    actions++;
    await save({ ...data, value: 42 });
  });
  assert.deepEqual({ attempts, actions, releases }, { attempts: 6, actions: 1, releases: 1 });
  assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), { kept: true, value: 42 });
});

test("EPERM has its own retry budget across ELOCKED attempts", async (t) => {
  const filename = fixture(t);
  let attempts = 0;
  const errors = ["EPERM", "ELOCKED", "EPERM", "ELOCKED", "EPERM", "EPERM", "EPERM", "EPERM"];
  t.mock.method(lockfile, "lock", async () => {
    throw failure(errors[attempts++] ?? "UNEXPECTED");
  });
  await assert.rejects(
    withLockedJsonFile(filename, () => assert.fail("must not enter mutation")),
    { code: "EPERM" },
  );
  assert.equal(attempts, 8);
  assert.equal(readFileSync(filename, "utf8"), '{"kept":true}');
});

test("non-Windows EPERM and other permission errors do not retry", async (t) => {
  const filename = fixture(t, "darwin");
  for (const code of ["EPERM", "EACCES"]) {
    let attempts = 0;
    t.mock.method(lockfile, "lock", async () => {
      attempts++;
      throw failure(code);
    });
    await assert.rejects(
      withLockedJsonFile(filename, () => assert.fail()),
      { code },
    );
    assert.equal(attempts, 1);
  }
});

test("mixed lock errors share the original deadline and a wait is cancellable", async (t) => {
  const filename = fixture(t);
  let now = 0,
    attempts = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(lockfile, "lock", async () => {
    attempts++;
    now = 30000;
    throw failure("EPERM");
  });
  await assert.rejects(
    withLockedJsonFile(filename, () => assert.fail()),
    { code: "EPERM" },
  );
  assert.equal(attempts, 1);
  const controller = new globalThis.AbortController();
  t.mock.method(lockfile, "lock", async () => {
    setImmediate(() => controller.abort(new Error("cancel lock wait")));
    throw failure("ELOCKED");
  });
  await assert.rejects(
    withLockedJsonFile(filename, () => assert.fail(), controller.signal),
    (error) => error.name === "AbortError" && error.cause === controller.signal.reason,
  );
});

test("mutation failures are not retried and a completed commit survives later cancellation", async (t) => {
  const filename = fixture(t);
  let attempts = 0,
    actions = 0,
    releases = 0;
  t.mock.method(lockfile, "lock", async () => {
    attempts++;
    return async () => {
      releases++;
    };
  });
  await assert.rejects(
    withLockedJsonFile(filename, () => {
      actions++;
      throw failure("EPERM");
    }),
    { code: "EPERM" },
  );
  const controller = new globalThis.AbortController();
  await withLockedJsonFile(
    filename,
    async (data, save) => {
      actions++;
      await save({ ...data, committed: true });
      controller.abort();
    },
    controller.signal,
  );
  assert.deepEqual({ attempts, actions, releases }, { attempts: 2, actions: 2, releases: 2 });
  assert.equal(JSON.parse(readFileSync(filename, "utf8")).committed, true);
});
