import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const root = path.resolve(import.meta.dirname, "..", "..");
const { ensureInstallationDeviceId } = await importTestBundle("installation-device-id", {
  packages: "external",
  absWorkingDir: root,
  entryPoints: ["src/agent-host/installation-device-id.ts"],
});
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-device-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("concurrent first logins reuse a verified global UUID and preserve settings", async (t) => {
  const dir = fixture(t);
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ packages: ["fixture-plugin"], unknown: { keep: true } }),
  );
  const ids = await Promise.all(Array.from({ length: 12 }, () => ensureInstallationDeviceId(dir)));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^[a-f0-9-]{36}$/);
  const settings = JSON.parse(readFileSync(path.join(dir, "settings.json")));
  assert.equal(settings.deviceId, ids[0]);
  assert.deepEqual(settings.packages, ["fixture-plugin"]);
  assert.deepEqual(settings.unknown, { keep: true });
  assert.equal(await ensureInstallationDeviceId(dir), ids[0]);
});

test("an existing CLI device ID is retained and project settings do not select it", async (t) => {
  const dir = fixture(t),
    project = path.join(dir, "project");
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(
    path.join(project, ".pi/settings.json"),
    JSON.stringify({ deviceId: "00000000-0000-0000-0000-000000000000" }),
  );
  const cli = SettingsManager.create(project, dir);
  const id = cli.getOrCreateDeviceId();
  await cli.flush();
  assert.equal(cli.drainErrors().length, 0);
  assert.equal(await ensureInstallationDeviceId(dir), id);
  assert.notEqual(id, "00000000-0000-0000-0000-000000000000");
});

test("invalid or unwritable settings reject installation ID creation without repair", async (t) => {
  const dir = fixture(t),
    filename = path.join(dir, "settings.json");
  for (const text of ["invalid JSON", JSON.stringify({ deviceId: "invalid" })]) {
    writeFileSync(filename, text);
    await assert.rejects(ensureInstallationDeviceId(dir));
    assert.equal(readFileSync(filename, "utf8"), text);
  }
  rmSync(filename);
  mkdirSync(filename);
  await assert.rejects(ensureInstallationDeviceId(dir));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    rmSync(filename, { recursive: true });
    writeFileSync(filename, "{}");
    chmodSync(dir, 0o500);
    try {
      await assert.rejects(ensureInstallationDeviceId(dir), (error) => ["EACCES", "EPERM"].includes(error.code));
      assert.equal(readFileSync(filename, "utf8"), "{}");
    } finally {
      chmodSync(dir, 0o700);
    }
  }
});
