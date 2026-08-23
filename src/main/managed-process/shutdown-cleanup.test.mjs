import assert from "node:assert/strict";
import test from "node:test";
import { cleanupManagedProcessContainment } from "./shutdown-cleanup.ts";

test("ordinary quit is bounded and retains uncertain reaper records", async () => {
  const logs = [];
  const startedAt = Date.now();
  await cleanupManagedProcessContainment({
    deadline: startedAt + 35,
    requireConfirmedEmpty: false,
    stopHost: () => new Promise(() => undefined),
    reapAll: () => new Promise(() => undefined),
    getStatus: () => ({ ready: false, records: 1, errorCode: "IDENTITY_UNCERTAIN" }),
    log: (message) => logs.push(message),
  });
  assert.ok(Date.now() - startedAt < 500, "ordinary quit exceeded its shared cleanup deadline");
  assert.ok(logs.some((line) => line.includes("host=deadline") && line.includes("records=1")));
});

test("prepare-to-install fails closed for uncertain identity without clearing the journal", async () => {
  const status = { ready: false, records: 1, errorCode: "IDENTITY_UNCERTAIN" };
  await assert.rejects(
    cleanupManagedProcessContainment({
      deadline: Date.now() + 1_000,
      requireConfirmedEmpty: true,
      stopHost: async () => undefined,
      reapAll: async () => status,
      getStatus: () => status,
    }),
    /could not be safely confirmed/,
  );
  assert.equal(status.records, 1);
});

test("prepare-to-install rejects reaper failures and successful cleanup requires zero records", async () => {
  await assert.rejects(
    cleanupManagedProcessContainment({
      deadline: Date.now() + 1_000,
      requireConfirmedEmpty: true,
      stopHost: async () => undefined,
      reapAll: async () => {
        throw new Error("journal flush failed");
      },
      getStatus: () => ({ ready: false, records: 1, errorCode: "JOURNAL_INVALID" }),
    }),
    /could not be safely confirmed/,
  );

  await cleanupManagedProcessContainment({
    deadline: Date.now() + 1_000,
    requireConfirmedEmpty: true,
    stopHost: async () => undefined,
    reapAll: async () => undefined,
    getStatus: () => ({ ready: true, records: 0 }),
  });
});
