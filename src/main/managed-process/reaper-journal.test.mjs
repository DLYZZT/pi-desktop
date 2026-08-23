import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReaperJournal, validateReaperRecord, writeReaperJournal } from "./reaper-journal.ts";

function record(overrides = {}) {
  return {
    version: 2,
    platform: "posix",
    processId: "proc-a",
    runId: "run-a",
    hostInstanceId: "host-a",
    pid: 123,
    pgid: 123,
    startFingerprint: "Thu Aug 20 10:00:00 2026",
    nonce: "nonce-a",
    createdAt: 1,
    ...overrides,
  };
}

function legacyRecord(overrides = {}) {
  const legacy = { ...record(overrides) };
  delete legacy.platform;
  return { ...legacy, version: 1 };
}

function windowsRecord(overrides = {}) {
  const nonce = "a".repeat(64);
  return {
    version: 2,
    platform: "win32",
    processId: "proc-win",
    runId: "run-win",
    hostInstanceId: "host-win",
    helperPid: 456,
    helperStartFingerprint: "12345:abcdef:build-a",
    jobName: `Local\\PiDesktop.Managed.${nonce}`,
    helperBuildId: "build-a",
    nonce,
    createdAt: 2,
    ...overrides,
  };
}

test("journal round trips minimal reaper records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-"));
  const file = path.join(directory, "journal.json");
  writeReaperJournal(file, 3, [record()]);
  const parsed = readReaperJournal(file);
  assert.equal(parsed.revision, 3);
  assert.deepEqual(parsed.records, [record()]);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes("command"), false);
  assert.equal(raw.includes("cwd"), false);
  assert.equal(raw.includes("output"), false);
  writeReaperJournal(file, 4, []);
  await assert.rejects(readFile(file, "utf8"), (error) => error.code === "ENOENT");
});

test("journal rejects unsafe permissions, oversized and malformed input", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-bad-"));
  const file = path.join(directory, "journal.json");
  await writeFile(file, JSON.stringify({ version: 1, revision: 0, records: [] }), { mode: 0o644 });
  await assert.rejects(async () => readReaperJournal(file, "darwin"));
  await chmod(file, 0o600);
  await writeFile(file, "{".repeat(70 * 1024));
  await assert.rejects(async () => readReaperJournal(file, "darwin"));
});

test("record validation rejects pid/pgid mismatch", () => {
  assert.throws(() => validateReaperRecord(record({ pgid: 456 })));
});

test("journal migrates POSIX v1 records and validates the Windows union", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-migrate-"));
  const file = path.join(directory, "journal.json");
  await writeFile(file, JSON.stringify({ version: 1, revision: 9, records: [legacyRecord()] }), { mode: 0o600 });
  assert.deepEqual(readReaperJournal(file, process.platform === "win32" ? "win32" : "darwin").records, [record()]);
  assert.deepEqual(validateReaperRecord(windowsRecord()), windowsRecord());
  assert.throws(() => validateReaperRecord(windowsRecord({ jobName: "Local\\PiDesktop.Managed.invalid" })));
  assert.throws(() => validateReaperRecord(windowsRecord({ helperPid: 1 })));
});

test("journal rejects old versions and duplicate identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-reaper-schema-"));
  const file = path.join(directory, "journal.json");
  await writeFile(file, JSON.stringify({ version: 0, revision: 0, records: [] }), { mode: 0o600 });
  assert.throws(() => readReaperJournal(file, "darwin"));
  await writeFile(file, JSON.stringify({ version: 1, revision: 1, records: [legacyRecord(), legacyRecord()] }), {
    mode: 0o600,
  });
  assert.throws(() => readReaperJournal(file, "darwin"));
});
