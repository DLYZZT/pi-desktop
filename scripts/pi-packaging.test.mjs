import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  assertFileSetSources,
  assertLockedPackage,
  createPiAuthoringFileSets,
  installedPiPackaging,
  validatePiAuthoringAssets,
} from "./pi-packaging.mjs";

const root = path.resolve(import.meta.dirname, "..");

for (const layout of ["hoisted", "nested"]) {
  test(`Pi ${layout} authoring assets keep imports, catalogs, docs and native modules complete`, () => {
    const coding = "node_modules/@earendil-works/pi-coding-agent";
    const prefix = layout === "nested" ? `${coding}/` : "";
    const manifests = new Map();
    const graph = new Map();
    const files = new Set();
    for (const name of ["pi-coding-agent", "pi-ai", "pi-tui", "pi-telemetry"]) {
      const directory = `${name === "pi-coding-agent" ? "" : prefix}node_modules/@earendil-works/${name}`;
      graph.set(directory, "1.0.4");
      manifests.set(`${directory}/package.json`, { name: `@earendil-works/${name}`, types: "./dist/index.d.ts" });
      files.add(`${directory}/dist/index.d.ts`);
      if (name === "pi-ai") files.add(`${directory}/dist/providers/data/amazon-bedrock.json`);
      if (name === "pi-tui") files.add(`${directory}/native/darwin/prebuilds/darwin-arm64/darwin-platform.node`);
    }
    for (const entry of ["README.md", "CHANGELOG.md", "docs/sdk.md", "docs/extensions.md", "docs/codemode.md"])
      files.add(`${coding}/${entry}`);
    const options = {
      graph,
      readPackage: (entry) => manifests.get(entry),
      exists: (entry) => files.has(entry),
      platform: "darwin",
      arch: "arm64",
    };
    assert.equal(validatePiAuthoringAssets(options).size, files.size);
    for (const entry of [...files]) {
      files.delete(entry);
      assert.throws(() => validatePiAuthoringAssets(options), /asset is missing/);
      files.add(entry);
    }
    const sets = createPiAuthoringFileSets(options);
    const ai = sets.find((entry) => entry.from.endsWith("/pi-ai"));
    assert.equal(ai.filter.includes("package.json"), layout === "nested");
    assert.equal(ai.filter.includes("dist/**/*.js"), layout === "nested");
    assert.equal(ai.filter.includes("dist/**/*.json"), layout === "nested");
    assert.ok(ai.filter.includes("dist/**/*.d.ts"));
    assert.ok(sets.find((entry) => entry.from === coding).filter.includes("docs/**/*"));
  });
}

test("a missing FileSet source fails before electron-builder can silently omit it", () => {
  assert.throws(
    () => assertFileSetSources(root, [{ from: "node_modules/missing-fixture", filter: ["**/*"] }], () => false),
    /FileSet source is missing/,
  );
  assert.doesNotThrow(() => assertFileSetSources(root, ["out/**/*", { from: "node_modules" }]));
});

test("ASAR package validation handles hoisting but rejects stale, unknown and contradictory locked versions", () => {
  const name = "@earendil-works/pi-tui";
  const directory = `node_modules/${name}`;
  const nested = `node_modules/@earendil-works/pi-coding-agent/${directory}`;
  const manifest = { name, version: "1.0.4" };
  const lock = { packages: { [nested]: { version: "1.0.4" } } };
  assert.doesNotThrow(() => assertLockedPackage(lock, directory, manifest));
  assert.throws(() => assertLockedPackage(lock, directory, { ...manifest, version: "1.0.3" }), /lockfile/);
  assert.throws(() => assertLockedPackage({ packages: {} }, directory, manifest), /lockfile/);
  lock.packages[directory] = { version: "1.0.3" };
  assert.throws(() => assertLockedPackage(lock, directory, manifest), /lockfile/);
});

test("the actual electron-builder loader resolves the inherited Pi configuration for every package entrypoint", async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { getConfig } = builderRequire("app-builder-lib/out/util/config/config.js");
  const config = await getConfig(root);
  const { graph, files } = installedPiPackaging(root);
  assertFileSetSources(root, config.files);
  for (const directory of graph.keys()) {
    assert.ok(
      config.files.some((entry) => entry.from === directory && entry.to === directory),
      directory,
    );
  }
  for (const entry of files) {
    assert.ok(existsSync(path.join(root, entry.from)), entry.from);
    const effective = config.files.find((item) => item.from === entry.from && item.to === entry.to);
    assert.ok(effective, entry.from);
    for (const pattern of entry.filter) assert.ok(effective.filter.includes(pattern), `${entry.from}: ${pattern}`);
  }
  assert.equal(config.appId, "app.dlyzzt.pi-agent-desktop");
  assert.equal(config.linux.executableArgs.includes("--no-sandbox"), false);
});
