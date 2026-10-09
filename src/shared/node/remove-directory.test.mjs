import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeDirectoryWithRetry } from "./remove-directory.ts";

test("directory removal waits for transient file locks and then completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remove-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "runtime.dll"), "runtime");
  let attempts = 0;
  let pauses = 0;
  await removeDirectoryWithRetry(
    root,
    async (directory, options) => {
      assert.equal(options.maxRetries, 0);
      if (++attempts < 3) throw Object.assign(new Error("in use"), { code: "EBUSY" });
      await rm(directory, options);
    },
    async () => {
      pauses += 1;
      assert.equal(await readFile(path.join(root, "runtime.dll"), "utf8"), "runtime");
    },
  );
  assert.equal(attempts, 3);
  assert.equal(pauses, 2);
  await assert.rejects(readFile(path.join(root, "runtime.dll")), { code: "ENOENT" });
});

test("a permanent file lock exhausts one shared retry budget and preserves the error", async () => {
  const locked = Object.assign(new Error("runtime still mapped"), { code: "EPERM" });
  let attempts = 0;
  let pauses = 0;
  await assert.rejects(
    removeDirectoryWithRetry(
      "fixture",
      async (_directory, options) => {
        attempts += 1;
        assert.equal(options.maxRetries, 0);
        throw locked;
      },
      async () => {
        pauses += 1;
      },
    ),
    (error) => error === locked,
  );
  assert.equal(attempts, 21);
  assert.equal(pauses, 20);
});

test("non-transient removal failures do not retry", async () => {
  const failure = Object.assign(new Error("I/O failure"), { code: "EIO" });
  await assert.rejects(
    removeDirectoryWithRetry(
      "fixture",
      async () => {
        throw failure;
      },
      async () => assert.fail("unexpected retry"),
    ),
    (error) => error === failure,
  );
});
