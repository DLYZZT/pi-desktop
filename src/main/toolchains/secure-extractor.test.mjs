import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import { extractRuntimeArchive, normalizeArchiveEntryPath, validateArchiveLink } from "./secure-extractor.ts";

test("normalizes safe archive paths and rejects traversal, absolute, drive, UNC, and backslash paths", () => {
  assert.equal(normalizeArchiveEntryPath("./node/bin/node"), "node/bin/node");
  for (const unsafe of ["../escape", "/absolute", "C:/escape", "\\\\server\\share", "dir\\file", "a/../../b"]) {
    assert.throws(() => normalizeArchiveEntryPath(unsafe), /unsafe|escapes/);
  }
});

test("allows contained relative links and rejects escaping or absolute links", () => {
  assert.doesNotThrow(() => validateArchiveLink("node/bin/npm", "../lib/npm.js"));
  assert.doesNotThrow(() => validateArchiveLink("node/bin/node", "node/bin/node", true));
  assert.throws(() => validateArchiveLink("node/bin/npm", "../../../outside"), /escapes/);
  assert.throws(() => validateArchiveLink("node/bin/npm", "/outside"), /unsafe/);
});

test("extracts a bounded tar.gz without invoking a system archive tool", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-safe-extract-"));
  try {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    const archive = path.join(directory, "runtime.tar.gz");
    mkdirSync(path.join(source, "runtime", "bin"), { recursive: true });
    writeFileSync(path.join(source, "runtime", "bin", "tool"), "safe", { mode: 0o755 });
    symlinkSync("tool", path.join(source, "runtime", "bin", "tool-link"));
    await tar.c({ cwd: source, file: archive, gzip: true }, ["runtime"]);
    await extractRuntimeArchive(archive, destination, "tar.gz", { maxExtractedBytes: 1_000_000 });
    assert.equal(readFileSync(path.join(destination, "runtime", "bin", "tool"), "utf8"), "safe");
    assert.equal(readFileSync(path.join(destination, "runtime", "bin", "tool-link"), "utf8"), "safe");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails before extraction exceeds the declared byte budget", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-safe-extract-limit-"));
  try {
    const source = path.join(directory, "source");
    const archive = path.join(directory, "runtime.tar.gz");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "large"), "x".repeat(4_096));
    await tar.c({ cwd: source, file: archive, gzip: true }, ["large"]);
    await assert.rejects(
      extractRuntimeArchive(archive, path.join(directory, "destination"), "tar.gz", { maxExtractedBytes: 32 }),
      (error) => error.code === "TOOLCHAIN_EXTRACTION_FAILED" && /byte limit/.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
