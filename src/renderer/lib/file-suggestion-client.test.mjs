import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const { FileSuggestionLruCache, fileSuggestionCacheKey, projectFileSuggestionResponse } = await importTestBundle(
  "src/renderer/lib/file-suggestion-client",
  {
    absWorkingDir: root,
    entryPoints: ["src/renderer/lib/file-suggestion-client.ts"],
  },
);

test("uses authoritative Host matches and preserves degradation metadata", () => {
  const result = projectFileSuggestionResponse(
    {
      files: ["legacy-only.txt"],
      matches: [
        { path: "src", isDir: true, score: 100 },
        { path: "src/main.ts", isDir: false, score: 80 },
        { path: "/outside", isDir: false },
        { path: "../outside", isDir: false },
        { path: "C:/outside", isDir: false },
        { path: "src\\outside", isDir: false },
      ],
      truncated: true,
      degradedReason: "search-timeout",
    },
    "src",
  );

  assert.deepEqual(result.matches, [
    { path: "src", isDir: true },
    { path: "src/main.ts", isDir: false },
  ]);
  assert.equal(result.truncated, true);
  assert.equal(result.degradedReason, "search-timeout");
});

test("falls back to the legacy files projection when matches is absent", () => {
  const result = projectFileSuggestionResponse(
    { files: ["README.md", "src/main.ts", "src/other.ts"], truncated: false },
    "src/ma",
  );
  assert.deepEqual(result.matches, [{ path: "src/main.ts", isDir: false }]);
});

test("normalizes Windows cache keys case-insensitively", () => {
  assert.equal(
    fileSuggestionCacheKey("C:\\Users\\Me\\Project\\", "Src/Main", "win32"),
    fileSuggestionCacheKey("c:/users/me/project", "src/main", "win32"),
  );
  assert.notEqual(fileSuggestionCacheKey("/Work", "Main", "darwin"), fileSuggestionCacheKey("/work", "main", "darwin"));
});

test("bounds entries with LRU eviction and expires stale values", () => {
  const cache = new FileSuggestionLruCache(2, 100);
  const first = { matches: [{ path: "first", isDir: false }], truncated: false };
  const second = { matches: [{ path: "second", isDir: false }], truncated: false };
  const third = { matches: [{ path: "third", isDir: false }], truncated: false };
  cache.set("first", first, 0);
  cache.set("second", second, 0);
  assert.equal(cache.get("first", 10), first);
  cache.set("third", third, 10);

  assert.equal(cache.size, 2);
  assert.equal(cache.get("second", 20), null);
  assert.equal(cache.get("first", 99), first);
  assert.equal(cache.get("first", 100), null);
});
