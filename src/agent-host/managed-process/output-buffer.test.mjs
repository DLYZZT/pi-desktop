import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedProcessOutputBuffer,
  ManagedProcessOutputDecoder,
  managedProcessCursor,
  parseManagedProcessCursor,
} from "./output-buffer.ts";

test("cursor is generation scoped", () => {
  assert.equal(parseManagedProcessCursor(managedProcessCursor("run-a", 42), "run-a"), 42);
  assert.equal(parseManagedProcessCursor(managedProcessCursor("run-a", 42), "run-b"), null);
  assert.equal(parseManagedProcessCursor("broken", "run-a"), null);
});

test("ring evicts oldest records and reports a gap", () => {
  const ring = new ManagedProcessOutputBuffer("run-a", 8, 10);
  ring.append("stdout", "1234");
  ring.append("stdout", "5678");
  ring.append("stdout", "90");
  const result = ring.read(managedProcessCursor("run-a", 0), 100);
  assert.deepEqual(
    result.records.map((record) => record.text),
    ["5678", "90"],
  );
  assert.deepEqual(result.gap, { droppedBytes: 4, droppedRecords: 1 });
});

test("decoder handles split utf8, CR progress and long line truncation", () => {
  const lines = [];
  const decoder = new ManagedProcessOutputDecoder((stream, line) => lines.push([stream, line]));
  const utf8 = Buffer.from("你\n", "utf8");
  decoder.write("stdout", utf8.subarray(0, 1));
  decoder.write("stdout", utf8.subarray(1));
  decoder.write("stderr", "10%\r20%\rready\n");
  decoder.write("stderr", "x".repeat(20 * 1024));
  decoder.end("stderr");
  assert.equal(lines[0][1], "你");
  assert.equal(lines[1][1], "ready");
  assert.match(lines[2][1], /line truncated: 4096 bytes/);
});

test("decoder handles flood-sized lines in bulk without changing line or CR semantics", () => {
  const lines = [];
  const decoder = new ManagedProcessOutputDecoder((stream, line) => lines.push([stream, line]));
  const floodLine = "x".repeat(10 * 1024 - 1);
  decoder.write("stdout", `${floodLine}\n${floodLine}\n`);
  decoder.write("stderr", "obsolete\r");
  decoder.write("stderr", "current\n");
  assert.deepEqual(lines, [
    ["stdout", floodLine],
    ["stdout", floodLine],
    ["stderr", "current"],
  ]);
});

test("output sanitizer strips terminal controls and common secrets", () => {
  const ring = new ManagedProcessOutputBuffer("run-a");
  ring.append(
    "stdout",
    "\u001b]0;hostile title\u0007\u001b]52;c;evil\u0007\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007 " +
      "\u001b[31mAuthorization: Bearer bearer-secret\u0000",
  );
  const [record] = ring.read(undefined, 1024).records;
  assert.equal(record.text.includes("\u001b"), false);
  assert.match(record.text, /Authorization: \[redacted\]/i);
  assert.equal(record.text.includes("bearer-secret"), false);
  assert.equal(record.text.includes("evil.test"), false);
  assert.equal(record.text.includes("\u0000"), false);
});

test("decoder replaces malformed utf8 without losing following output", () => {
  const lines = [];
  const decoder = new ManagedProcessOutputDecoder((_stream, line) => lines.push(line));
  decoder.write("stdout", Buffer.from([0xe2, 0x28, 0xa1, 0x0a, 0x6f, 0x6b, 0x0a]));
  decoder.end("stdout");
  assert.equal(lines.at(-1), "ok");
});

test("decoder reports a high invalid UTF-8 ratio only once", () => {
  let warnings = 0;
  const decoder = new ManagedProcessOutputDecoder(
    () => {},
    () => warnings++,
  );
  decoder.write("stdout", Buffer.alloc(40, 0xff));
  decoder.write("stderr", Buffer.alloc(40, 0xff));
  decoder.end("stdout");
  decoder.end("stderr");
  assert.equal(warnings, 1);
});
