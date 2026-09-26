import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { createTextPreviewReader } = await importTestBundle("text-preview", {
  entryPoints: [path.join(import.meta.dirname, "text-preview.ts")],
});
const LIMIT = 256 * 1024;

function memoryFile(content, options = {}) {
  const bytes = Buffer.from(content),
    calls = { requested: [], read: 0, closed: 0, stats: 0 };
  const reader = createTextPreviewReader(async () => ({
    async stat() {
      calls.stats++;
      if (options.statError) throw new Error("stat fixture failed");
      return { isFile: () => options.regular !== false, size: options.size?.(calls.stats) ?? bytes.length };
    },
    async read(buffer, offset, length, position) {
      calls.requested.push(length);
      if (options.readError) throw new Error("read fixture failed");
      const count = Math.max(0, Math.min(length, bytes.length - position, options.shortRead ?? Infinity));
      bytes.copy(buffer, offset, position, position + count);
      calls.read += count;
      return { bytesRead: count };
    },
    async close() {
      calls.closed++;
    },
  }));
  return { reader, calls };
}

test("empty and small UTF-8 files retain their contents and close the descriptor", async () => {
  for (const text of ["", "plain\ntext", "中文🙂"]) {
    const { reader, calls } = memoryFile(text);
    assert.deepEqual(await reader("fixture", LIMIT), {
      content: text,
      size: Buffer.byteLength(text),
      truncated: false,
    });
    assert.equal(calls.closed, 1);
    assert.equal(calls.read, Buffer.byteLength(text));
  }
});

test("every UTF-8 truncation boundary remains valid while reading at most budget plus one byte", async () => {
  const text = "你好🙂xyz";
  const expected = [
    "",
    "",
    "",
    "你",
    "你",
    "你",
    "你好",
    "你好",
    "你好",
    "你好",
    "你好🙂",
    "你好🙂x",
    "你好🙂xy",
    text,
  ];
  for (let budget = 0; budget <= Buffer.byteLength(text); budget++) {
    const { reader, calls } = memoryFile(text, { shortRead: 1 });
    const result = await reader("fixture", budget);
    assert.equal(result.content, expected[budget]);
    assert.equal(result.truncated, budget < Buffer.byteLength(text));
    assert.ok(calls.read <= budget + 1);
    assert.ok(Buffer.byteLength(result.content) <= budget);
    assert.equal(calls.closed, 1);
  }
});

test("descriptor size changes do not expand the read budget or falsely truncate a shrunken file", async () => {
  const growing = memoryFile("x".repeat(LIMIT + 10), { size: (count) => (count === 1 ? 1 : LIMIT + 10) });
  const grown = await growing.reader("fixture", LIMIT);
  assert.equal(grown.content.length, LIMIT);
  assert.equal(grown.size, LIMIT + 10);
  assert.equal(grown.truncated, true);
  assert.equal(growing.calls.read, LIMIT + 1);
  const shrinking = memoryFile("tiny", { size: (count) => (count === 1 ? 8 * 1024 ** 3 : 4) });
  assert.deepEqual(await shrinking.reader("fixture", LIMIT), { content: "tiny", size: 4, truncated: false });
  assert.equal(shrinking.calls.read, 4);
});

test("open, descriptor-stat, special-file and repeated read failures do not leak handles", async () => {
  let opens = 0;
  const missing = createTextPreviewReader(async () => {
    opens++;
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  await assert.rejects(missing("fixture", LIMIT), { code: "ENOENT" });
  assert.equal(opens, 1);
  for (const options of [{ regular: false }, { statError: true }, { readError: true }]) {
    const { reader, calls } = memoryFile("data", options);
    for (let i = 0; i < 20; i++) await assert.rejects(reader("fixture", LIMIT));
    assert.equal(calls.closed, 20);
    if (options.regular === false || options.statError) assert.equal(calls.requested.length, 0);
  }
  const { reader, calls } = memoryFile("data");
  await assert.rejects(reader("fixture", -1), RangeError);
  assert.equal(calls.stats, 0);
});

test("a held asynchronous read leaves other Host work runnable", async () => {
  const reading = createDeferred(),
    release = createDeferred();
  const reader = createTextPreviewReader(async () => ({
    async stat() {
      return { isFile: () => true, size: 1 };
    },
    async read(buffer, offset, _length, position) {
      if (position) return { bytesRead: 0 };
      reading.resolve();
      await release.promise;
      buffer[offset] = 65;
      return { bytesRead: 1 };
    },
    async close() {},
  }));
  const preview = reader("fixture", 8);
  await reading.promise;
  let ping = false;
  await new Promise((resolve) =>
    setImmediate(() => {
      ping = true;
      resolve();
    }),
  );
  assert.equal(ping, true);
  release.resolve();
  assert.equal((await preview).content, "A");
});

test(
  "a POSIX FIFO is rejected without a blocking open and its descriptor is closed",
  {
    skip: process.platform === "win32" ? "POSIX FIFO semantics" : false,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-text-fifo-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fifo = path.join(directory, "fifo");
    execFileSync("mkfifo", [fifo]);
    let closed = 0;
    const reader = createTextPreviewReader(async (file, flags) => {
      assert.ok(flags & constants.O_NONBLOCK, "reject a regression before attempting a blocking open");
      const handle = await open(file, flags);
      return {
        stat: () => handle.stat(),
        read: (...args) => handle.read(...args),
        async close() {
          closed++;
          await handle.close();
        },
      };
    });
    await assert.rejects(reader(fifo, LIMIT), (error) => error.code === "BAD_REQUEST");
    assert.equal(closed, 1);
  },
);

test(
  "a real 8 GiB sparse file reads only its bounded prefix",
  {
    skip:
      process.platform === "win32"
        ? "POSIX sparse-file fixture; Windows uses the deterministic byte-count cases"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-text-preview-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "large.txt");
    await writeFile(filePath, "large fixture\n");
    const creator = await open(filePath, "r+");
    await creator.truncate(8 * 1024 ** 3);
    await creator.close();
    let bytes = 0,
      closed = 0;
    const reader = createTextPreviewReader(async (file, flags) => {
      const handle = await open(file, flags);
      return {
        stat: () => handle.stat(),
        async read(buffer, offset, length, position) {
          assert.ok(position + length <= LIMIT + 1);
          const result = await handle.read(buffer, offset, length, position);
          bytes += result.bytesRead;
          return result;
        },
        async close() {
          closed++;
          await handle.close();
        },
      };
    });
    const result = await reader(filePath, LIMIT);
    assert.equal(result.size, 8 * 1024 ** 3);
    assert.equal(result.truncated, true);
    assert.ok(result.content.startsWith("large fixture\n"));
    assert.equal(bytes, LIMIT + 1);
    assert.equal(closed, 1);
  },
);
