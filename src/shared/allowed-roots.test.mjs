import assert from "node:assert/strict";
import test from "node:test";

import {
  allowFileRoot,
  allowedRootsCacheTtlMs,
  getAllowedRootsCache,
  getAllowedRootsGeneration,
  invalidateAllowedRootsCache,
  setAllowedRootsCache,
  setAllowedRootsCacheIfCurrent,
  setAllowedRootsWatcherHealthy,
} from "./allowed-roots.ts";

test("TTL is short without a healthy watcher and long with one", () => {
  setAllowedRootsWatcherHealthy(false);
  const fallback = allowedRootsCacheTtlMs();

  setAllowedRootsWatcherHealthy(true);
  const watched = allowedRootsCacheTtlMs();

  assert.equal(fallback, 5_000);
  assert.ok(watched > fallback, "watched TTL must exceed the fallback TTL");

  setAllowedRootsWatcherHealthy(false);
  assert.equal(allowedRootsCacheTtlMs(), fallback);
});

test("allowFileRoot updates the live cache and invalidate drops it", () => {
  setAllowedRootsCache({ roots: new Set(["/a"]), expiresAt: Date.now() + 60_000 });

  allowFileRoot("C:\\work\\repo");
  assert.ok(getAllowedRootsCache().roots.has("C:/work/repo"), "new root is visible without waiting for a re-scan");

  invalidateAllowedRootsCache();
  assert.equal(getAllowedRootsCache(), undefined);
});

test("an invalidated async scan cannot restore a stale cache entry", () => {
  invalidateAllowedRootsCache();
  const scanGeneration = getAllowedRootsGeneration();

  invalidateAllowedRootsCache();
  const accepted = setAllowedRootsCacheIfCurrent(
    { roots: new Set(["/stale"]), expiresAt: Date.now() + 10 * 60_000 },
    scanGeneration,
  );

  assert.equal(accepted, false);
  assert.equal(getAllowedRootsCache(), undefined);

  const currentGeneration = getAllowedRootsGeneration();
  const fresh = { roots: new Set(["/fresh"]), expiresAt: Date.now() + 10 * 60_000 };
  assert.equal(setAllowedRootsCacheIfCurrent(fresh, currentGeneration), true);
  assert.equal(getAllowedRootsCache(), fresh);
});
