import assert from "node:assert/strict";
import test from "node:test";

import { parseRuntimeCatalog } from "./catalog-schema.ts";

function validCatalog() {
  return {
    schemaVersion: 2,
    revision: 1,
    components: [
      {
        id: "node-lts",
        version: "24.18.0",
        provides: ["js.node", "js.npm", "js.npx"],
        license: {
          name: "Node.js license",
          url: "https://github.com/nodejs/node/blob/v24.18.0/LICENSE",
        },
        variants: [
          {
            platform: "darwin",
            arch: "arm64",
            url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz",
            sha256: "A".repeat(64),
            downloadBytes: 42_000_000,
            installedBytes: 120_000_000,
            archive: "tar.gz",
            installer: "safe-archive",
          },
        ],
      },
    ],
  };
}

test("parses a fixed, allowlisted catalog and normalizes hashes", () => {
  const parsed = parseRuntimeCatalog(validCatalog());

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.components[0].id, "node-lts");
  assert.equal(parsed.components[0].variants[0].sha256, "a".repeat(64));
});

test("rejects latest aliases and placeholders in versions or URLs", () => {
  const latest = validCatalog();
  latest.components[0].version = "latest";
  assert.throws(() => parseRuntimeCatalog(latest), /placeholder or latest/i);

  const placeholder = validCatalog();
  placeholder.components[0].variants[0].url = "https://nodejs.org/dist/<version>/node.tar.gz";
  assert.throws(() => parseRuntimeCatalog(placeholder), /placeholder or latest/i);

  const traversal = validCatalog();
  traversal.components[0].version = "../../24.18.0";
  assert.throws(() => parseRuntimeCatalog(traversal), /safe path segment/i);
});

test("rejects non-HTTPS, credentialed, and non-allowlisted artifact URLs", () => {
  const insecure = validCatalog();
  insecure.components[0].variants[0].url = "http://nodejs.org/dist/v24.18.0/node.tar.gz";
  assert.throws(() => parseRuntimeCatalog(insecure), /credential-free HTTPS/i);

  const credentialed = validCatalog();
  credentialed.components[0].variants[0].url =
    "https://user:secret@nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz";
  assert.throws(() => parseRuntimeCatalog(credentialed), /credential-free HTTPS/i);

  const wrongHost = validCatalog();
  wrongHost.components[0].variants[0].url = "https://example.com/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz";
  assert.throws(() => parseRuntimeCatalog(wrongHost), /allowlist/i);
});

test("rejects missing integrity metadata, zero sizes, and duplicate variants", () => {
  const badHash = validCatalog();
  badHash.components[0].variants[0].sha256 = "abc";
  assert.throws(() => parseRuntimeCatalog(badHash), /64 hexadecimal/i);

  const zeroSize = validCatalog();
  zeroSize.components[0].variants[0].downloadBytes = 0;
  assert.throws(() => parseRuntimeCatalog(zeroSize), /positive integer/i);

  const duplicate = validCatalog();
  duplicate.components[0].variants.push({ ...duplicate.components[0].variants[0] });
  assert.throws(() => parseRuntimeCatalog(duplicate), /duplicate platform\/arch/i);
});

test("restricts installer and archive combinations", () => {
  const binaryNode = validCatalog();
  binaryNode.components[0].variants[0].archive = "binary";
  assert.throws(() => parseRuntimeCatalog(binaryNode), /safe-archive cannot install/i);

  const unsupportedCompression = validCatalog();
  unsupportedCompression.components[0].variants[0].archive = "tar.xz";
  assert.throws(() => parseRuntimeCatalog(unsupportedCompression), /must be one of/i);

  const portableGit = validCatalog();
  portableGit.components[0] = {
    id: "portable-git",
    version: "2.55.0.3",
    provides: ["vcs.git", "shell.bash"],
    license: {
      name: "GNU GPL v2",
      url: "https://github.com/git-for-windows/git/blob/main/COPYING",
    },
    variants: [
      {
        platform: "win32",
        arch: "x64",
        url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/PortableGit-2.55.0.3-64-bit.7z.exe",
        sha256: "b".repeat(64),
        downloadBytes: 62_000_000,
        archive: "7z-sfx",
        installer: "portable-git-sfx",
      },
    ],
  };
  assert.equal(parseRuntimeCatalog(portableGit).components[0].id, "portable-git");

  portableGit.components[0].variants[0].platform = "darwin";
  assert.throws(() => parseRuntimeCatalog(portableGit), /restricted to portable-git win32/i);
});

test("rejects unknown schema fields and duplicate component versions while allowing retained versions", () => {
  const unknown = validCatalog();
  unknown.components[0].command = "curl | sh";
  assert.throws(() => parseRuntimeCatalog(unknown), /unknown keys/i);

  const duplicate = validCatalog();
  duplicate.components.push(structuredClone(duplicate.components[0]));
  assert.throws(() => parseRuntimeCatalog(duplicate), /ID\/version pairs must be unique/i);

  const retained = validCatalog();
  const older = structuredClone(retained.components[0]);
  older.version = "24.17.0";
  older.variants[0].url = "https://nodejs.org/dist/v24.17.0/node-v24.17.0-darwin-arm64.tar.gz";
  retained.components.push(older);
  assert.equal(parseRuntimeCatalog(retained).components.length, 2);
});
