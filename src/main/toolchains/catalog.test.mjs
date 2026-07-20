import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findCatalogComponent, findCatalogVariant, loadRuntimeCatalog } from "./catalog.ts";

test("loads the shipped fixed catalog for every current release platform", () => {
  const catalog = loadRuntimeCatalog(path.resolve("build/toolchains/runtime-catalog.json"));
  for (const componentId of ["node-lts", "cpython", "uv", "bun"]) {
    const component = findCatalogComponent(catalog, componentId);
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
      ["linux", "x64"],
    ]) {
      const variant = findCatalogVariant(component, platform, arch);
      assert.match(variant.sha256, /^[a-f0-9]{64}$/);
      assert.equal(variant.url.includes("latest"), false);
    }
  }
});
