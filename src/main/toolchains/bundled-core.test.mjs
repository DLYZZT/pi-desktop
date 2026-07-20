import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledSeedsFromResources, legacyUpstreamSearchSeeds, resolveBundledCorePaths } from "./bundled-core.ts";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("loads only bundled core executables and licenses matching the signed manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bundled-core-"));
  try {
    const target = path.join(root, "darwin-arm64");
    fs.mkdirSync(path.join(target, "manifests"), { recursive: true });
    fs.mkdirSync(path.join(target, "licenses"), { recursive: true });
    const executable = Buffer.from("fixed rg binary");
    const license = Buffer.from("fixed license");
    fs.writeFileSync(path.join(target, "rg"), executable, { mode: 0o755 });
    fs.writeFileSync(path.join(target, "licenses", "rg.txt"), license);
    const catalog = {
      schemaVersion: 2,
      revision: 3,
      components: [
        {
          id: "ripgrep",
          version: "15.2.0",
          provides: ["search.rg"],
          license: { name: "MIT", url: "https://example.invalid/license" },
          variants: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/rg.tar.gz",
              sha256: "a".repeat(64),
              downloadBytes: 1,
              archive: "tar.gz",
              installer: "safe-archive",
            },
          ],
        },
      ],
    };
    const manifest = {
      schemaVersion: 1,
      catalogRevision: 3,
      platform: "darwin",
      arch: "arm64",
      tools: [
        {
          componentId: "ripgrep",
          capability: "search.rg",
          version: "15.2.0",
          executable: "rg",
          sha256: digest(executable),
          bytes: executable.length,
          artifactSha256: "a".repeat(64),
        },
      ],
      licenses: [
        {
          componentId: "ripgrep",
          path: "licenses/rg.txt",
          sourceUrl: "https://example.invalid/license",
          sha256: digest(license),
        },
      ],
    };
    fs.writeFileSync(path.join(target, "manifests", "core-tools.json"), JSON.stringify(manifest));

    const seeds = await bundledSeedsFromResources({ coreRoot: root, catalog, platform: "darwin", arch: "arm64" });
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].provider, "bundled");
    assert.equal(seeds[0].executable, path.join(target, "rg"));

    fs.writeFileSync(path.join(target, "rg"), "modified");
    assert.deepEqual(
      await bundledSeedsFromResources({ coreRoot: root, catalog, platform: "darwin", arch: "arm64" }),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers legacy upstream rg/fd read-only with the lowest provider priority", () => {
  const existing = new Set(["/Users/test/.pi/agent/bin/rg"]);
  const seeds = legacyUpstreamSearchSeeds({
    homeDir: "/Users/test",
    platform: "darwin",
    fileSystem: {
      isFile: (value) => existing.has(value),
      isDirectory: () => false,
      readDirectoryNames: () => [],
      realpath: (value) => value,
    },
  });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].capability, "search.rg");
  assert.equal(seeds[0].provider, "legacy-upstream-managed");
  assert.equal(seeds[0].discovery, "legacy-upstream-managed:read-only");
});

test("resolves development and packaged core roots without consulting PATH", () => {
  assert.deepEqual(resolveBundledCorePaths({ isPackaged: false, resourcesRoot: "/ignored", applicationRoot: "/app" }), {
    catalogPath: path.join("/app", "build", "toolchains", "core-catalog.json"),
    coreRoot: path.join("/app", "build", "toolchains", "core"),
  });
  assert.deepEqual(resolveBundledCorePaths({ isPackaged: true, resourcesRoot: "/resources" }), {
    catalogPath: path.join("/resources", "toolchains", "core-catalog.json"),
    coreRoot: path.join("/resources", "toolchains", "core"),
  });
});
