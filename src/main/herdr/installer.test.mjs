import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
const compatibleProbe = {
  version: catalog.version,
  protocol: catalog.protocol,
  schemaVersion: catalog.apiSchemaVersion,
  schemaSha256: catalog.apiSchemaSha256,
};

async function loadInstaller() {
  return importTestBundle("src/main/herdr/installer", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/installer.ts"],
  });
}

function fixture(directory, overrides = {}) {
  const bundleRoot = path.join(directory, "bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const executable = path.join(bundleRoot, "herdr");
  const contents = Buffer.from("#!/bin/sh\nexit 0\n");
  writeFileSync(executable, contents);
  chmodSync(executable, 0o700);
  const license = path.join(bundleRoot, "LICENSE");
  writeFileSync(license, "Apache License\n");
  const manifest = {
    schemaVersion: 1,
    version: catalog.version,
    protocol: catalog.protocol,
    apiSchemaVersion: catalog.apiSchemaVersion,
    apiSchemaSha256: catalog.apiSchemaSha256,
    platform: "linux",
    arch: "x64",
    executable: "herdr",
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
    artifactSha256: catalog.artifacts["linux-x64"].sha256,
    ...overrides,
  };
  return { manifest, executable, license };
}

function createInstaller(HerdrInstaller, directory, bundle, probe = async () => compatibleProbe) {
  return new HerdrInstaller({
    userDataDir: path.join(directory, "user-data"),
    catalogPath: path.resolve("build/herdr/runtime-catalog.json"),
    bundledRoot: path.join(directory, "unused"),
    platform: "linux",
    arch: "x64",
    probe,
    loadBundle: () => bundle,
  });
}

test("bundled Herdr install, repair state, and removal share the Developer Tools lifecycle", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-bundled-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = fixture(directory);
  const installer = createInstaller(HerdrInstaller, directory, bundle);

  const before = installer.inspect();
  assert.equal(before.componentId, "herdr");
  assert.equal(before.installed, false);
  assert.equal(before.canInstall, true);
  assert.equal(before.downloadBytes, 0);

  const progress = [];
  const installed = await installer.install((value) => progress.push(value));
  assert.equal(installed, path.join(directory, "user-data", "herdr", "runtimes", "0.8.2", "linux-x64", "herdr"));
  assert.deepEqual(
    progress.map(({ phase }) => phase),
    ["verifying", "verifying", "probing", "activating", "ready"],
  );
  assert.deepEqual(
    progress.slice(0, 2).map(({ downloadedBytes }) => downloadedBytes),
    [0, catalog.artifacts["linux-x64"].downloadBytes],
  );
  assert.equal(progress[0].totalBytes, catalog.artifacts["linux-x64"].downloadBytes);
  assert.equal(installer.inspect().health, "healthy");
  assert.equal(installer.inspect().canRepair, true);

  const sessionMarker = path.join(directory, "user-data", "herdr", "session-marker");
  writeFileSync(sessionMarker, "keep");
  await installer.remove();
  assert.equal(installer.inspect().installed, false);
  assert.equal(readFileSync(sessionMarker, "utf8"), "keep");
});

test("a failed staged probe leaves the active managed runtime untouched", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-probe-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = fixture(directory);
  const healthy = createInstaller(HerdrInstaller, directory, bundle);
  const installed = await healthy.install();
  const original = readFileSync(installed);

  const failing = createInstaller(HerdrInstaller, directory, bundle, async () => ({
    ...compatibleProbe,
    protocol: 19,
  }));
  await assert.rejects(failing.install(), (error) => error.code === "TOOLCHAIN_BROKEN");
  assert.deepEqual(readFileSync(installed), original);
});

test("post-activation probe failure atomically restores the previous runtime", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-activation-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = fixture(directory);
  const finalRoot = path.join(directory, "user-data", "herdr", "runtimes", "0.8.2", "linux-x64");
  mkdirSync(finalRoot, { recursive: true });
  const existing = path.join(finalRoot, "herdr");
  writeFileSync(existing, "existing-runtime");
  let probes = 0;
  const installer = createInstaller(HerdrInstaller, directory, bundle, async () =>
    ++probes === 1 ? compatibleProbe : { ...compatibleProbe, schemaSha256: "f".repeat(64) },
  );

  await assert.rejects(installer.install(), (error) => error.code === "TOOLCHAIN_BROKEN");
  assert.equal(readFileSync(existing, "utf8"), "existing-runtime");
});

test("corrupt bundled content is rejected and cancellation cannot activate a runtime", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-integrity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const corrupt = fixture(directory, { sha256: "f".repeat(64) });
  const installer = createInstaller(HerdrInstaller, directory, corrupt);
  await assert.rejects(installer.install(), (error) => error.code === "TOOLCHAIN_INTEGRITY_FAILED");

  const controller = new globalThis.AbortController();
  controller.abort();
  const valid = createInstaller(HerdrInstaller, directory, fixture(path.join(directory, "valid")));
  await assert.rejects(valid.install(undefined, controller.signal), (error) => error.code === "TOOLCHAIN_CANCELLED");
  assert.equal(
    existsSync(path.join(directory, "user-data", "herdr", "runtimes", "0.8.2", "linux-x64", "herdr")),
    false,
  );
});

test("stale operation locks are recovered before bundled activation", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-stale-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockRoot = path.join(directory, "user-data", "herdr", "locks");
  mkdirSync(lockRoot, { recursive: true });
  writeFileSync(path.join(lockRoot, "install.lock"), JSON.stringify({ pid: 2_147_483_647, version: "0.8.2" }));
  const installer = createInstaller(HerdrInstaller, directory, fixture(directory));
  assert.equal(existsSync(await installer.install()), true);
  assert.equal(existsSync(path.join(lockRoot, "install.lock")), false);
});

test("a stale malformed operation lock is reclaimed without following links", async (t) => {
  const { HerdrInstaller } = await loadInstaller();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-corrupt-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockRoot = path.join(directory, "user-data", "herdr", "locks");
  mkdirSync(lockRoot, { recursive: true });
  const lockPath = path.join(lockRoot, "install.lock");
  writeFileSync(lockPath, "not-json", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  const installer = createInstaller(HerdrInstaller, directory, fixture(directory));
  assert.equal(existsSync(await installer.install()), true);
  assert.equal(existsSync(lockPath), false);
});
