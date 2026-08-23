import assert from "node:assert/strict";
import test from "node:test";
import { projectManagedProcessCapability } from "./capability.ts";

const descriptor = {
  path: "C:\\fixed\\pi-managed-process-helper.exe",
  manifestPath: "C:\\fixed\\manifest.json",
  protocolVersion: 1,
  buildId: "build-a",
  arch: "x64",
  provenance: "windows-native-dev",
  sha256: "a".repeat(64),
};

test("managed process capability preserves the real platform and fails closed by health", () => {
  assert.deepEqual(
    projectManagedProcessCapability({
      platform: "win32",
      arch: "arm64",
      reaperReady: true,
      helper: null,
      ownerReady: true,
      windowsRelease: "10.0.26100",
      windowsVersion: "Windows 11 Pro",
    }),
    {
      platform: "win32",
      arch: "arm64",
      supported: false,
      ready: false,
      backend: "none",
      errorCode: "ARCH_UNSUPPORTED",
    },
  );
  assert.equal(
    projectManagedProcessCapability({
      platform: "win32",
      arch: "x64",
      reaperReady: true,
      helper: { ok: false, errorCode: "HELPER_INTEGRITY" },
      ownerReady: true,
      windowsRelease: "10.0.26100",
      windowsVersion: "Windows 11 Pro",
    }).errorCode,
    "HELPER_INTEGRITY",
  );
  assert.equal(
    projectManagedProcessCapability({
      platform: "win32",
      arch: "x64",
      reaperReady: false,
      helper: { ok: true, descriptor },
      ownerReady: true,
      windowsRelease: "10.0.26100",
      windowsVersion: "Windows 11 Pro",
    }).errorCode,
    "REAPER_UNHEALTHY",
  );
});

test("Windows Job capability becomes ready only with helper, reaper, and current owner", () => {
  const waiting = projectManagedProcessCapability({
    platform: "win32",
    arch: "x64",
    reaperReady: true,
    helper: { ok: true, descriptor },
    ownerReady: false,
    windowsRelease: "10.0.26100",
    windowsVersion: "Windows 11 Pro",
  });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.errorCode, "OWNER_IDENTITY_UNAVAILABLE");
  const ready = projectManagedProcessCapability({
    platform: "win32",
    arch: "x64",
    reaperReady: true,
    helper: { ok: true, descriptor },
    ownerReady: true,
    windowsRelease: "10.0.26100",
    windowsVersion: "Windows 11 Pro",
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.backend, "windows-job");
  assert.equal(ready.helperBuildId, "build-a");
  assert.equal(ready.errorCode, undefined);
});

test("Windows Server and pre-Windows-10 releases remain unsupported", () => {
  for (const [windowsRelease, windowsVersion] of [
    ["10.0.20348", "Windows Server 2022 Datacenter"],
    ["6.3.9600", "Windows 8.1 Pro"],
  ]) {
    const capability = projectManagedProcessCapability({
      platform: "win32",
      arch: "x64",
      reaperReady: true,
      helper: { ok: true, descriptor },
      ownerReady: true,
      windowsRelease,
      windowsVersion,
    });
    assert.equal(capability.supported, false);
    assert.equal(capability.errorCode, "PLATFORM_UNSUPPORTED");
  }
});

test("POSIX capability does not depend on the Windows helper or owner ACK", () => {
  const ready = projectManagedProcessCapability({
    platform: "linux",
    arch: "x64",
    reaperReady: true,
    helper: null,
    ownerReady: false,
  });
  assert.equal(ready.supported, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.backend, "posix-group");
});
