import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createBoundedTextDiff, MAX_DIFF_INPUT_BYTES } from "./text-diff.ts";

test("bounded diff preserves ordinary line edits", () => {
  const result = createBoundedTextDiff("one\ntwo\nthree", "one\nchanged\nthree");
  assert.equal(result.kind, "lines");
  assert.deepEqual(
    result.lines.map(({ type, text }) => [type, text]),
    [
      ["unchanged", "one"],
      ["removed", "two"],
      ["added", "changed"],
      ["unchanged", "three"],
    ],
  );
});

test("two high-difference 256 KB inputs enter fallback before Myers allocation", () => {
  const size = 256 * 1024;
  const started = performance.now();
  const result = createBoundedTextDiff("a".repeat(size), "b".repeat(size));
  const elapsed = performance.now() - started;

  assert.deepEqual(result, { kind: "fallback", reason: "bytes", oldLines: 1, newLines: 1 });
  assert.ok(elapsed < 250, `preflight took ${elapsed.toFixed(1)}ms`);
  assert.ok(size * 2 > MAX_DIFF_INPUT_BYTES);
});

test("line, edit-distance, and trace budgets each produce a summary fallback", () => {
  const tooManyLines = `${"same\n".repeat(8_100)}old`;
  const tooManyNewLines = `${"same\n".repeat(8_100)}new`;
  assert.equal(createBoundedTextDiff(tooManyLines, tooManyNewLines).reason, "lines");

  const highEditOld = Array.from({ length: 700 }, (_, i) => `old-${i}`).join("\n");
  const highEditNew = Array.from({ length: 700 }, (_, i) => `new-${i}`).join("\n");
  assert.equal(createBoundedTextDiff(highEditOld, highEditNew).reason, "edit-distance");

  const traceOld = Array.from({ length: 550 }, (_, i) => `old-${i}`).join("\n");
  const traceNew = Array.from({ length: 550 }, (_, i) => `new-${i}`).join("\n");
  assert.equal(createBoundedTextDiff(traceOld, traceNew).reason, "trace");
});

test("bounded Myers scripts reconstruct both inputs across varied edits", () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  for (let attempt = 0; attempt < 250; attempt += 1) {
    const oldLines = Array.from({ length: Math.floor(random() * 14) }, () => String(Math.floor(random() * 6)));
    const newLines = Array.from({ length: Math.floor(random() * 14) }, () => String(Math.floor(random() * 6)));
    const oldContent = oldLines.join("\n");
    const newContent = newLines.join("\n");
    const result = createBoundedTextDiff(oldContent, newContent);
    assert.equal(result.kind, "lines");
    assert.equal(
      result.lines
        .filter(({ type }) => type !== "added")
        .map(({ text }) => text)
        .join("\n"),
      oldContent,
    );
    assert.equal(
      result.lines
        .filter(({ type }) => type !== "removed")
        .map(({ text }) => text)
        .join("\n"),
      newContent,
    );
  }
});
