import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AsyncRotatingFileLogger, HostOutputLineBuffer, sanitizeLogLine } from "./logger-core.ts";

test("sanitizes sensitive values and truncates log lines", () => {
  const line = sanitizeLogLine(
    'authorization=Bearer abc.def token="top-secret" url=https://user:password@example.test/path\nnext',
    100,
  );

  assert.equal(line.includes("abc.def"), false);
  assert.equal(line.includes("top-secret"), false);
  assert.equal(line.includes("user:password"), false);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /redacted/);
  assert.match(sanitizeLogLine("x".repeat(100), 40), /truncated/);
  assert.equal(sanitizeLogLine("-----BEGIN PRIVATE KEY----- secret"), "<redacted-private-key-material>");
});

test("batches Host output by line and bounds an unterminated line", () => {
  const batches = [];
  const buffer = new HostOutputLineBuffer((lines) => batches.push([...lines]), 5, 2);

  buffer.push("first\r\nsec");
  buffer.push("ond\n0123456789\npartial");
  buffer.flush();

  assert.deepEqual(batches.flat(), ["first", "secon… [truncated]", "01234… [truncated]", "parti… [truncated]"]);
  assert.ok(batches.every((batch) => batch.length <= 2));
});

test("writes asynchronously and rotates bounded log generations", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-main-logger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "main.log");
  const logger = new AsyncRotatingFileLogger({
    filePath,
    maxBytes: 64,
    maxGenerations: 2,
    maxQueueBytes: 64,
    flushIntervalMs: 60_000,
  });

  logger.append(["first generation\n"]);
  await logger.flush();
  logger.append([`${"a".repeat(50)}\n`]);
  await logger.flush();
  logger.append([`${"b".repeat(50)}\n`]);
  await logger.flush();
  logger.append([`${"c".repeat(50)}\n`]);
  await logger.flush();

  assert.equal(await readFile(filePath, "utf8"), `${"c".repeat(50)}\n`);
  assert.equal(await readFile(`${filePath}.1`, "utf8"), `${"b".repeat(50)}\n`);
  assert.equal(await readFile(`${filePath}.2`, "utf8"), `${"a".repeat(50)}\n`);
});

test("drops oldest entries when the in-memory queue is full", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-main-logger-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "main.log");
  const logger = new AsyncRotatingFileLogger({
    filePath,
    maxBytes: 64,
    maxGenerations: 1,
    maxQueueBytes: 12,
    flushIntervalMs: 60_000,
  });

  logger.append(["oldest\n", "middle\n", "latest\n"]);
  await logger.flush();
  const content = await readFile(filePath, "utf8");

  assert.match(content, /dropped 2 queued entries/);
  assert.equal(content.includes("oldest"), false);
  assert.equal(content.includes("middle"), false);
  assert.match(content, /latest/);
});

test("retains a bounded batch across a transient disk error", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-main-logger-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blockedDirectory = path.join(directory, "blocked");
  await writeFile(blockedDirectory, "not a directory");
  const errors = [];
  const filePath = path.join(blockedDirectory, "main.log");
  const logger = new AsyncRotatingFileLogger({
    filePath,
    maxBytes: 64,
    maxGenerations: 1,
    maxQueueBytes: 32,
    flushIntervalMs: 60_000,
    retryIntervalMs: 60_000,
    onError: (error) => errors.push(error),
  });

  logger.append(["retained after failure\n"]);
  await logger.flush();
  assert.equal(errors.length, 1);

  await unlink(blockedDirectory);
  await logger.flush();
  assert.equal(await readFile(filePath, "utf8"), "retained after failure\n");
});
