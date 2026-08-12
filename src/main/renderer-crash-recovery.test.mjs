import assert from "node:assert/strict";
import test from "node:test";
import { RendererCrashRecovery } from "./renderer-crash-recovery.ts";

test("classifies intentional exits and non-recoverable renderer failures", () => {
  const recovery = new RendererCrashRecovery();

  assert.deepEqual(recovery.record("clean-exit"), { kind: "ignore" });
  assert.deepEqual(recovery.record("killed"), { kind: "ignore" });
  assert.deepEqual(recovery.record("oom"), { kind: "halt", reason: "oom" });
  assert.deepEqual(recovery.record("launch-failed"), { kind: "halt", reason: "launch-failed" });
  assert.deepEqual(recovery.record("integrity-failure"), { kind: "halt", reason: "integrity-failure" });
});

test("applies exponential backoff and halts a renderer crash loop", () => {
  let now = 1_000;
  const recovery = new RendererCrashRecovery({ now: () => now });

  assert.deepEqual(recovery.record("crashed"), { kind: "reload", attempt: 1, delayMs: 250 });
  assert.deepEqual(recovery.record("abnormal-exit"), { kind: "reload", attempt: 2, delayMs: 500 });
  assert.deepEqual(recovery.record("memory-eviction"), { kind: "reload", attempt: 3, delayMs: 1_000 });
  assert.deepEqual(recovery.record("crashed"), { kind: "halt", reason: "crash-loop" });

  now += 60_000;
  assert.deepEqual(recovery.record("crashed"), { kind: "reload", attempt: 1, delayMs: 250 });
  recovery.reset();
  assert.deepEqual(recovery.record("crashed"), { kind: "reload", attempt: 1, delayMs: 250 });
});
