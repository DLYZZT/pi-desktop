import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";

const { CacheWarmingSettings, isCacheWarmingMode } = await importTestBundle("pi-cache-warming-settings", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "cache-warming-settings.ts")],
});

test("global cache warming defaults without a write and preserves other Pi settings on explicit change", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-cache-setting-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  const modes = [];
  const service = new CacheWarmingSettings(
    () => SettingsManager.create(directory, directory),
    async (mode) => {
      modes.push(mode);
      return 0;
    },
  );
  assert.deepEqual(await service.get(), {
    mode: "streaming",
    scope: "global",
    loadFailed: false,
    pendingSessionCount: 0,
  });
  assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ defaultProvider: "anthropic" }));
  assert.deepEqual(await service.set("off"), {
    mode: "off",
    scope: "global",
    loadFailed: false,
    pendingSessionCount: 0,
  });
  assert.deepEqual(modes, ["off"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    defaultProvider: "anthropic",
    cacheWarming: "off",
  });
  writeFileSync(file, JSON.stringify({ cacheWarming: "idle" }));
  assert.equal((await service.get()).mode, "idle");
  assert.equal(isCacheWarmingMode("unknown"), false);
  await assert.rejects(service.set("unknown"), /Invalid cache warming mode/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cacheWarming, "idle");
});

test("a persisted change reports live sessions that still need a refresh", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-cache-setting-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new CacheWarmingSettings(
    () => SettingsManager.create(directory, directory),
    async () => 1,
  );
  const status = await service.set("idle");
  assert.equal(status.mode, "idle");
  assert.equal(status.pendingSessionCount, 1);
  assert.equal(JSON.parse(readFileSync(path.join(directory, "settings.json"), "utf8")).cacheWarming, "idle");
});

test("a failed global write never reports success or synchronizes active sessions", async () => {
  let synchronized = false;
  const settings = {
    getCacheWarmingMode: () => "streaming",
    setCacheWarmingMode: () => undefined,
    flush: async () => undefined,
    drainErrors: () => [{ scope: "global", error: new Error("fixture write failure") }],
  };
  const service = new CacheWarmingSettings(
    () => settings,
    async () => {
      synchronized = true;
      return 0;
    },
  );
  await assert.rejects(service.set("off"), /Global Pi settings/);
  assert.equal(synchronized, false);
});
