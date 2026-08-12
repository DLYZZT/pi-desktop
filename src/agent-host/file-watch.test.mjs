import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
