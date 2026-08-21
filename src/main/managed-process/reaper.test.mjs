import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagedProcessReaper } from "./reaper.ts";

function record() {
  return {
    version: 1,
    processId: "proc-a",
    runId: "run-a",
    hostInstanceId: "host-a",
    pid: 123,
    pgid: 123,
    startFingerprint: "fingerprint-a",
    nonce: "nonce-a",
    createdAt: 1,
  };
}

test("reaper registers and removes exact nonce identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-service-"));
  const reaper = new ManagedProcessReaper(path.join(directory, "journal.json"), {
    platform: "darwin",
    groupExists: () => false,
  });
  assert.equal((await reaper.initialize()).ready, true);
  assert.equal(reaper.register(record()).journalRevision, 1);
  assert.throws(() => reaper.unregister({ ...record(), nonce: "wrong" }));
  assert.equal(reaper.unregister(record()).removed, true);
});

test("reaper fails closed when a live pid fingerprint does not match", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-identity-"));
  const reaper = new ManagedProcessReaper(path.join(directory, "journal.json"), {
    platform: "darwin",
    groupExists: () => true,
    fingerprint: async () => "different",
    terminateGroup: async () => {
      throw new Error("must not signal");
    },
  });
  await reaper.initialize();
  reaper.register(record());
  const status = await reaper.reapAll();
  assert.equal(status.ready, false);
  assert.equal(status.errorCode, "IDENTITY_UNCERTAIN");
  assert.equal(status.records, 1);
});

test("reaper fails closed when a verified process group cannot be terminated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-failure-"));
  const reaper = new ManagedProcessReaper(path.join(directory, "journal.json"), {
    platform: "linux",
    groupExists: () => true,
    fingerprint: async () => "fingerprint-a",
    terminateGroup: async () => false,
  });
  await reaper.initialize();
  reaper.register(record());
  const status = await reaper.reapAll();
  assert.equal(status.ready, false);
  assert.equal(status.errorCode, "REAP_FAILED");
  assert.equal(status.records, 1);
});
