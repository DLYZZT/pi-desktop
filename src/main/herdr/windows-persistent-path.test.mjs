import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

async function loadReader() {
  return importTestBundle("src/main/herdr/windows-persistent-path", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/windows-persistent-path.ts"],
  });
}

test("Windows persistent Path reads fixed registry keys and expands bounded known variables", async () => {
  const { readWindowsPersistentPath } = await loadReader();
  const queried = [];
  const entries = await readWindowsPersistentPath(
    {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Ada",
      APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    },
    async (key) => {
      queried.push(key);
      return key.startsWith("HKCU")
        ? "\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;relative;%UNKNOWN%\\bin;C:\\Tools\\bin\r\n"
        : "\r\n    Path    REG_SZ    %SystemRoot%\\System32;C:\\Tools\\bin\r\n";
    },
  );
  assert.deepEqual(queried, [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ]);
  assert.deepEqual(entries, ["C:\\Users\\Ada\\bin", "C:\\Tools\\bin", "C:\\Windows\\System32"]);
});

test("Windows persistent Path ignores oversized, relative, malformed, and untrusted values", async () => {
  const { readWindowsPersistentPath, expandWindowsPathEntry } = await loadReader();
  const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Ada" };
  for (const invalid of [
    ".",
    "bin",
    "%APPDATA%\\npm",
    "%UNKNOWN%\\bin",
    "C:\\bad\npath",
    "C:\\bad%",
    "C:\\x".repeat(2000),
  ]) {
    assert.equal(expandWindowsPathEntry(invalid, env), undefined);
  }
  const result = await readWindowsPersistentPath(env, async () => "x".repeat(17 * 1024));
  assert.deepEqual(result, []);
});
