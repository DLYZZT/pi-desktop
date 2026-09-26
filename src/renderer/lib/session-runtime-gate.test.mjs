import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuntimeGate } from "./session-runtime-gate.ts";

test("a live field update invalidates only that part of an initial snapshot", () => {
  const gate = new SessionRuntimeGate();
  const initial = gate.capture();
  gate.touch("queue");
  assert.equal(gate.accept(initial, "queue"), false);
  assert.equal(gate.accept(initial, "run"), true);
  assert.equal(gate.accept(initial, "usage"), true);
});

test("a newer applied snapshot wins even if an older request finishes later", () => {
  const gate = new SessionRuntimeGate();
  const older = gate.capture(),
    newer = gate.capture();
  assert.equal(gate.accept(newer, "usage"), true);
  assert.equal(gate.accept(older, "usage"), false);
  assert.equal(gate.accept(older, "statuses"), true, "a newer partial snapshot did not contain this field");
});

test("local and external run boundaries invalidate all earlier runtime work", () => {
  const gate = new SessionRuntimeGate();
  const previous = gate.capture();
  gate.beginRun();
  assert.equal(gate.isCurrentRun(previous), false);
  for (const field of ["run", "queue", "compaction", "statuses", "widgets", "thinking", "usage", "systemPrompt"]) {
    assert.equal(gate.accept(previous, field), false);
    assert.equal(gate.accept(gate.capture(), field), true);
  }
});
