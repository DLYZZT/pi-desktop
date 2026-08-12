import assert from "node:assert/strict";
import test from "node:test";

import { parseBundledToolTargets } from "./bundled-tools-targets.mjs";

test("release and default modes use the actual host architecture", () => {
  assert.deepEqual(parseBundledToolTargets(["--release"], { platform: "darwin", arch: "arm64" }), ["darwin-arm64"]);
  assert.deepEqual(parseBundledToolTargets(["--release"], { platform: "darwin", arch: "x64" }), ["darwin-x64"]);
  assert.deepEqual(parseBundledToolTargets(["--release"], { platform: "win32", arch: "x64" }), ["win32-x64"]);
  assert.deepEqual(parseBundledToolTargets([], { platform: "linux", arch: "x64" }), ["linux-x64"]);
});

test("unsupported host release targets fail before any preparation starts", () => {
  assert.throws(
    () => parseBundledToolTargets(["--release"], { platform: "win32", arch: "arm64" }),
    /unsupported release target: win32-arm64/,
  );
  assert.throws(
    () => parseBundledToolTargets([], { platform: "linux", arch: "arm64" }),
    /unsupported release target: linux-arm64/,
  );
});

test("explicit release matrices are validated and deduplicated", () => {
  assert.deepEqual(parseBundledToolTargets(["--all"]), ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
  assert.deepEqual(parseBundledToolTargets(["--target", "darwin-arm64", "--target", "darwin-arm64"]), ["darwin-arm64"]);
  assert.throws(() => parseBundledToolTargets(["--target"]), /--target requires platform-arch/);
  assert.throws(() => parseBundledToolTargets(["--target", "freebsd-x64"]), /unsupported release target: freebsd-x64/);
  assert.throws(() => parseBundledToolTargets(["--unknown"]), /unknown argument: --unknown/);
});
