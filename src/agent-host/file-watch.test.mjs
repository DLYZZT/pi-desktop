import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { EventEmitter } from "node:events";
const { allowFileRoot, createFileWatchService, getActiveFileWatchCount, stopAllFileWatches } = await importTestBundle(
  "src/agent-host/file-watch",
  {
    packages: "external",
    stdin: {
      contents:
        'export { allowFileRoot } from "./file-access.ts"; export { createFileWatchService, getActiveFileWatchCount, stopAllFileWatches } from "./file-watch.ts";',
      resolveDir: import.meta.dirname,
      sourcefile: "file-watch-test-entry.ts",
      loader: "ts",
    },
  },
);

test("file watch leases release shared refs independently and shutdown closes the remainder", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-file-watch-"));
  const filePath = path.join(directory, "watched.txt");
  writeFileSync(filePath, "initial", "utf8");
  allowFileRoot(directory);
  t.after(() => {
    stopAllFileWatches();
    rmSync(directory, { recursive: true, force: true });
  });
  const service = createFileWatchService({ emit() {} });

  const releaseFirst = await service.start(filePath);
  const releaseSecond = await service.start(filePath);
  assert.equal(getActiveFileWatchCount(), 1);

  releaseFirst();
  releaseFirst();
  assert.equal(getActiveFileWatchCount(), 1, "one remaining lease keeps the shared watcher alive");
  releaseSecond();
  assert.equal(getActiveFileWatchCount(), 0);

  await service.start(filePath);
  assert.equal(getActiveFileWatchCount(), 1);
  stopAllFileWatches();
  assert.equal(getActiveFileWatchCount(), 0);
});

test("an old file-watch release cannot close a replacement watcher for the same path", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-file-watch-replacement-"));
  const filePath = path.join(directory, "watched.txt");
  writeFileSync(filePath, "fixture");
  allowFileRoot(directory);
  t.after(() => {
    stopAllFileWatches();
    rmSync(directory, { recursive: true, force: true });
  });
  const service = createFileWatchService({ emit() {} });
  const oldRelease = await service.start(filePath);
  stopAllFileWatches();
  const newRelease = await service.start(filePath);
  oldRelease();
  assert.equal(getActiveFileWatchCount(), 1);
  newRelease();
  assert.equal(getActiveFileWatchCount(), 0);
});

test("late change and error callbacks from a retired watcher cannot affect its replacement", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-file-watch-events-"));
  const filePath = path.join(directory, "watched.txt");
  writeFileSync(filePath, "fixture");
  allowFileRoot(directory);
  const watches = [],
    events = [],
    timers = new Map();
  const set = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 100) return set(callback, delay, ...args);
    const timer = {};
    timers.set(timer, callback);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (timers.has(timer)) timers.delete(timer);
    else clear(timer);
  });
  t.mock.method(fs, "watch", (...args) => {
    const watcher = new EventEmitter();
    watcher.closed = 0;
    watcher.close = () => watcher.closed++;
    watches.push({ watcher, change: args.at(-1) });
    return watcher;
  });
  t.after(() => {
    stopAllFileWatches();
    rmSync(directory, { recursive: true, force: true });
  });
  const service = createFileWatchService({ emit: (_topic, _path, event) => events.push(event) });
  const oldRelease = await service.start(filePath);
  watches[0].watcher.emit("error", new Error("Retired"));
  const replacement = await service.start(filePath);
  const count = events.length;
  watches[0].change();
  watches[0].watcher.emit("error", new Error("Late error"));
  oldRelease();
  assert.equal(getActiveFileWatchCount(), 1);
  assert.equal(watches[1].watcher.closed, 0);
  assert.equal(events.length, count);
  assert.equal(timers.size, 0);
  replacement();
});
