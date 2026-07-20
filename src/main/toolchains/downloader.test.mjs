import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadRuntimeArtifact } from "./downloader.ts";

function variant(bytes, overrides = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    url: "https://nodejs.org/dist/v24.18.0/node.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    downloadBytes: bytes.length,
    archive: "tar.gz",
    installer: "safe-archive",
    ...overrides,
  };
}

test("streams an exact allowlisted artifact and reports bounded progress", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-download-"));
  try {
    const bytes = Buffer.from("verified artifact");
    const progress = [];
    const destination = path.join(directory, "artifact.partial");
    await downloadRuntimeArtifact("node-lts", variant(bytes), destination, {
      fetchImpl: async () =>
        new globalThis.Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
      onProgress: (value) => progress.push(value),
    });
    assert.deepEqual(readFileSync(destination), bytes);
    assert.deepEqual(progress.at(-1), { downloadedBytes: bytes.length, totalBytes: bytes.length });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects size and checksum mismatches and removes the partial artifact", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-download-bad-"));
  try {
    const destination = path.join(directory, "artifact.partial");
    const expected = Buffer.from("expected");
    const actual = Buffer.from("tampered");
    await assert.rejects(
      downloadRuntimeArtifact("node-lts", variant(expected), destination, {
        fetchImpl: async () => new globalThis.Response(actual, { status: 200 }),
      }),
      (error) => error.code === "TOOLCHAIN_INTEGRITY_FAILED",
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a redirect outside the fixed download host set", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-download-redirect-"));
  try {
    await assert.rejects(
      downloadRuntimeArtifact("node-lts", variant(Buffer.from("x")), path.join(directory, "artifact"), {
        fetchImpl: async () =>
          new globalThis.Response(null, { status: 302, headers: { location: "https://evil.invalid/a" } }),
      }),
      (error) => error.code === "TOOLCHAIN_DOWNLOAD_REJECTED",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aborts an in-flight download and removes its partial artifact", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-download-cancel-"));
  try {
    const destination = path.join(directory, "artifact.partial");
    const controller = new globalThis.AbortController();
    const pending = downloadRuntimeArtifact("node-lts", variant(Buffer.from("x")), destination, {
      signal: controller.signal,
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init.signal.aborted) reject(new Error("aborted"));
          else init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "TOOLCHAIN_CANCELLED");
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
