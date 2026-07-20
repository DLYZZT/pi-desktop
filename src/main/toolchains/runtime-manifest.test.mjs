import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolchainPaths, runtimeDirectory } from "./paths.ts";
import { managedSeedsFromState, verifyRuntimeManifest, writeRuntimeManifest } from "./runtime-manifest.ts";
import { emptyToolchainState } from "./state-store.ts";

const component = {
  id: "node-lts",
  version: "24.18.0",
  provides: ["js.node", "js.npm", "js.npx"],
  license: { name: "Node.js", url: "https://example.invalid/license" },
  variants: [],
};

test("loads only active managed entrypoints whose key-file hashes still match", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-runtime-manifest-"));
  try {
    const paths = createToolchainPaths(directory);
    const runtimeRoot = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    const executable = path.join(runtimeRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "runtime", { mode: 0o755 });
    await writeRuntimeManifest({
      runtimeRoot,
      component,
      platformArch: `${process.platform}-${process.arch}`,
      catalogRevision: 1,
      artifactSha256: "a".repeat(64),
      entrypoint: { capability: "js.node", executable },
      keyFiles: [],
      installedAt: "2026-07-17T00:00:00.000Z",
    });
    const state = emptyToolchainState();
    state.managed["node-lts"] = {
      activeVersion: "24.18.0",
      platformArch: `${process.platform}-${process.arch}`,
      installedVersions: ["24.18.0"],
    };
    const catalog = { schemaVersion: 2, revision: 1, components: [component] };
    const seeds = await managedSeedsFromState({
      paths,
      state,
      catalog,
      platform: process.platform,
      arch: process.arch,
    });
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].provider, "managed");
    assert.equal(seeds[0].componentId, "node-lts");

    writeFileSync(executable, "modified", "utf8");
    assert.equal(
      await verifyRuntimeManifest({ runtimeRoot, component, platformArch: `${process.platform}-${process.arch}` }),
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps installed rollback versions discoverable after the release catalog advances", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-runtime-manifest-versions-"));
  try {
    const paths = createToolchainPaths(directory);
    const older = { ...component, version: "23.11.0" };
    for (const current of [component, older]) {
      const runtimeRoot = runtimeDirectory(paths, "node-lts", current.version, process.platform, process.arch);
      const executable = path.join(runtimeRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, current.version, { mode: 0o755 });
      await writeRuntimeManifest({
        runtimeRoot,
        component: current,
        platformArch: `${process.platform}-${process.arch}`,
        catalogRevision: 1,
        artifactSha256: "b".repeat(64),
        entrypoint: { capability: "js.node", executable },
        keyFiles: [],
        installedAt: "2026-07-17T00:00:00.000Z",
      });
    }
    const state = emptyToolchainState();
    state.managed["node-lts"] = {
      activeVersion: component.version,
      platformArch: `${process.platform}-${process.arch}`,
      installedVersions: [older.version, component.version],
    };
    const seeds = await managedSeedsFromState({
      paths,
      state,
      catalog: { schemaVersion: 2, revision: 2, components: [component] },
      platform: process.platform,
      arch: process.arch,
    });
    assert.equal(seeds.length, 2);
    assert.match(seeds[0].discovery, new RegExp(component.version.replaceAll(".", "\\.")));
    assert.equal(seeds[0].rank, 5_000);
    assert.ok(seeds[1].rank > seeds[0].rank);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
