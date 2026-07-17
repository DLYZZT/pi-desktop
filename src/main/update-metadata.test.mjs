import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseUpdateMetadata, verifyUpdateMetadata } from "../../scripts/verify-update-metadata.mjs";

function digest(content) {
  return createHash("sha512").update(content).digest("base64");
}

test("release metadata must exactly match artifact bytes, sizes, and blockmaps", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-update-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, "Pi-Agent-Desktop-0.2.0-arm64.zip");
  const second = path.join(directory, "Pi-Agent-Desktop-0.2.0-x64.zip");
  writeFileSync(first, "arm64 artifact");
  writeFileSync(second, "x64 artifact");
  writeFileSync(`${first}.blockmap`, "arm64 blockmap");
  writeFileSync(`${second}.blockmap`, "x64 blockmap");
  const metadata = path.join(directory, "latest-mac.yml");
  writeFileSync(
    metadata,
    [
      "version: 0.2.0",
      "files:",
      `  - url: ${path.basename(first)}`,
      `    sha512: ${digest("arm64 artifact")}`,
      "    size: 14",
      `  - url: ${path.basename(second)}`,
      `    sha512: ${digest("x64 artifact")}`,
      "    size: 12",
    ].join("\n"),
  );

  await verifyUpdateMetadata(metadata, "0.2.0", [first, second]);
  writeFileSync(first, "tampered artifact");
  await assert.rejects(verifyUpdateMetadata(metadata, "0.2.0", [first, second]), /size mismatch|SHA-512 mismatch/);
});

test("metadata parser accepts quoted scalars and rejects documents without file entries", () => {
  assert.deepEqual(parseUpdateMetadata("version: '0.2.0'\nfiles:\n  - url: 'app.zip'\n    sha512: abc\n    size: 1"), {
    version: "0.2.0",
    entries: [{ url: "app.zip", sha512: "abc", size: "1" }],
  });
  assert.throws(() => parseUpdateMetadata("version: 0.2.0\nfiles: []"), /no file entries/);
});
