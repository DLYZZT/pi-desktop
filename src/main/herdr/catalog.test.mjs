import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { findHerdrRuntimeArtifact, parseHerdrRuntimeCatalog } from "./catalog.ts";

const shipped = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));

test("Herdr runtime catalog accepts only the pinned official platform assets", () => {
  const catalog = parseHerdrRuntimeCatalog(shipped);
  assert.equal(findHerdrRuntimeArtifact(catalog, "darwin", "arm64").downloadBytes, 18_969_952);
  assert.equal(findHerdrRuntimeArtifact(catalog, "win32", "x64").url.endsWith(".zip"), true);
  assert.throws(() => findHerdrRuntimeArtifact(catalog, "linux", "arm64"), /unavailable/);
});

test("Herdr runtime catalog rejects URL, digest, size, and schema drift", () => {
  const variants = [
    { ...shipped, version: "latest" },
    {
      ...shipped,
      artifacts: {
        ...shipped.artifacts,
        "darwin-arm64": { ...shipped.artifacts["darwin-arm64"], url: "https://example.test/herdr" },
      },
    },
    {
      ...shipped,
      artifacts: {
        ...shipped.artifacts,
        "darwin-arm64": { ...shipped.artifacts["darwin-arm64"], sha256: "0".repeat(64) },
      },
    },
    {
      ...shipped,
      artifacts: { ...shipped.artifacts, "darwin-arm64": { ...shipped.artifacts["darwin-arm64"], downloadBytes: 0 } },
    },
    { ...shipped, extra: true },
  ];
  for (const value of variants) assert.throws(() => parseHerdrRuntimeCatalog(value));
});
