import assert from "node:assert/strict";
import test from "node:test";
import { getProcessStartFingerprint, parseLinuxProcessStatStartTime } from "./process-tree.ts";

test("parses Linux proc stat start time even when comm contains spaces and parentheses", () => {
  const prefix = "4321 (worker ) with spaces)";
  const fields = [
    "S",
    "1",
    "4321",
    "4321",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "987654",
  ];
  assert.equal(parseLinuxProcessStatStartTime(`${prefix} ${fields.join(" ")}`), "987654");
  assert.equal(parseLinuxProcessStatStartTime("malformed"), null);
  assert.equal(parseLinuxProcessStatStartTime("1 (x) S 1 2"), null);
});

test("reads a stable fingerprint for the current POSIX process", async () => {
  if (process.platform === "win32") return;
  const first = await getProcessStartFingerprint(process.pid);
  const second = await getProcessStartFingerprint(process.pid);
  assert.ok(first);
  assert.equal(second, first);
  if (process.platform === "linux") assert.match(first, /^linux:[a-f0-9-]{36}:\d+$/u);
});
