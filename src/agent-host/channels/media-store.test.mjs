import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeferred, createManualScheduler } from "#test-timing";
const { ChannelMediaStore, CHANNEL_MEDIA_MAX_ATTACHMENTS, CHANNEL_MEDIA_MAX_BYTES, CHANNEL_MEDIA_TTL_MS } =
  await importTestBundle("src/agent-host/channels/media-store", {
    packages: "external",
    stdin: {
      contents:
        'export { ChannelMediaStore, CHANNEL_MEDIA_MAX_ATTACHMENTS, CHANNEL_MEDIA_MAX_BYTES, CHANNEL_MEDIA_TTL_MS } from "./media-store.ts";',
      resolveDir: import.meta.dirname,
      sourcefile: "channel-media-test-entry.ts",
      loader: "ts",
    },
  });

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("media staging randomizes disk names, sanitizes display names, and uses private permissions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-channel-media-"));
  const store = new ChannelMediaStore(root);
  await store.initialize();
  const [saved] = await store.stage("account", "event", [
    { kind: "image", data: png, name: "../../secret.png", mime: "image/svg+xml" },
  ]);
  assert.equal(saved.name, "secret.png");
  assert.equal(saved.mime, "image/png");
  assert.equal(path.basename(saved.path).includes("secret"), false);
  assert.equal(path.extname(saved.path), ".png");
  assert.deepEqual(await readFile(saved.path), png);
  // Windows exposes synthesized POSIX mode bits; its access control is governed by ACLs.
  if (process.platform !== "win32") {
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  }
});

test("media staging rejects invalid images, oversized data, and attachment floods", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-channel-media-limits-"));
  const store = new ChannelMediaStore(root);
  await store.initialize();
  await assert.rejects(store.stage("a", "bad-image", [{ kind: "image", data: Buffer.from("<svg/>") }]), /图片格式/);
  await assert.rejects(
    store.stage("a", "large", [{ kind: "file", data: Buffer.alloc(CHANNEL_MEDIA_MAX_BYTES + 1) }]),
    /20 MiB/,
  );
  await assert.rejects(
    store.stage(
      "a",
      "many",
      Array.from({ length: CHANNEL_MEDIA_MAX_ATTACHMENTS + 1 }, () => ({ kind: "file", data: Buffer.from("x") })),
    ),
    /最多支持/,
  );
});

test("expired channel media is removed without touching fresh events", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-channel-media-ttl-"));
  const store = new ChannelMediaStore(root);
  await store.initialize();
  const [oldFile] = await store.stage("a", "old", [{ kind: "file", data: Buffer.from("old") }]);
  const [freshFile] = await store.stage("a", "fresh", [{ kind: "file", data: Buffer.from("fresh") }]);
  const now = Date.now();
  const oldTime = new Date(now - CHANNEL_MEDIA_TTL_MS - 1_000);
  await utimes(path.dirname(oldFile.path), oldTime, oldTime);
  await store.cleanupExpired(now);
  await assert.rejects(stat(oldFile.path));
  assert.equal((await stat(freshFile.path)).isFile(), true);
});

test("media staging refuses a symlinked root", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "pi-channel-media-symlink-"));
  const real = path.join(parent, "real");
  mkdirSync(real);
  const link = path.join(parent, "link");
  await symlink(real, link, "dir");
  await assert.rejects(new ChannelMediaStore(link).initialize(), /不是安全的本地目录/);
});

test("periodic and opportunistic cleanup stop when the media store is disposed", async () => {
  const periodicRoot = mkdtempSync(path.join(tmpdir(), "pi-channel-media-periodic-"));
  const scheduler = createManualScheduler();
  const periodicCleanupFinished = createDeferred();
  const periodic = new ChannelMediaStore(periodicRoot, { cleanupIntervalMs: 5, timers: scheduler });
  let periodicCleanups = 0;
  periodic.cleanupExpired = async () => {
    periodicCleanups += 1;
    if (periodicCleanups === 2) periodicCleanupFinished.resolve();
  };
  await periodic.initialize();
  await scheduler.runNext();
  await periodicCleanupFinished.promise;
  assert.equal(periodicCleanups, 2, "the periodic timer should clean after startup");
  await periodic.dispose();
  assert.equal(scheduler.pendingCount(), 0);

  let now = 1_000;
  const opportunisticRoot = mkdtempSync(path.join(tmpdir(), "pi-channel-media-opportunistic-"));
  const opportunistic = new ChannelMediaStore(opportunisticRoot, {
    cleanupIntervalMs: 60_000,
    now: () => now,
  });
  let opportunisticCleanups = 0;
  opportunistic.cleanupExpired = async () => {
    opportunisticCleanups += 1;
  };
  await opportunistic.initialize();
  now += 60_001;
  await opportunistic.stage("account", "event", [{ kind: "file", data: Buffer.from("x") }]);
  await opportunistic.dispose();
  assert.equal(opportunisticCleanups, 2);
});
