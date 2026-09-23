#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log(JSON.stringify({ ok: true, skipped: "Windows x64 NSIS acceptance only" }));
  process.exit(0);
}

const [previousArgument, currentArgument, ...extra] = process.argv.slice(2);
if (!previousArgument || !currentArgument || extra.length > 0) {
  throw new Error("Usage: test-windows-nsis-upgrade.mjs <previous-installer.exe> <current-installer.exe>");
}
const previousInstaller = regularFile(previousArgument);
const currentInstaller = regularFile(currentArgument);
const previousVersion = fileVersion(previousInstaller);
const currentVersion = fileVersion(currentInstaller);
assert.ok(compareVersions(previousVersion, currentVersion) < 0, `${previousVersion} must precede ${currentVersion}`);
assertCleanUserInstallState();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "Pi NSIS upgrade 回滚 "));
const installPath = path.join(root, "Install Unicode 空格 With Spaces");
const isolated = path.join(root, "isolated-user");
fs.mkdirSync(isolated, { recursive: true });
const reports = [];
let installed = false;
let completed = false;

try {
  await install(previousInstaller, installPath);
  installed = true;
  assert.equal(fileVersion(appExecutable(installPath)), previousVersion);
  assert.equal(fs.existsSync(path.join(installPath, "resources", "managed-process")), false);
  reports.push(validateStartup(appExecutable(installPath), isolated, previousVersion, "previous"));

  await install(currentInstaller, installPath);
  assert.equal(fileVersion(appExecutable(installPath)), currentVersion);
  const helper = await verifyInstalledHelper(installPath);
  reports.push(validateStartup(appExecutable(installPath), isolated, currentVersion, "upgraded"));

  await install(previousInstaller, installPath);
  assert.equal(fileVersion(appExecutable(installPath)), previousVersion);
  assert.equal(
    fs.existsSync(path.join(installPath, "resources", "managed-process")),
    false,
    "direct rollback must remove the newer helper directory",
  );
  reports.push(validateStartup(appExecutable(installPath), isolated, previousVersion, "rolled-back"));

  uninstall(installPath);
  installed = false;
  assertCleanUserInstallState(20_000);
  assertNoMaterialInstallResidue(installPath, 20_000);
  completed = true;
  console.log(
    JSON.stringify({
      ok: true,
      previousVersion,
      currentVersion,
      previousInstallerSha256: sha256(previousInstaller),
      currentInstallerSha256: sha256(currentInstaller),
      helper,
      reports,
      scenarios: ["previous packaged startup", "cross-version upgrade", "direct rollback", "official uninstall"],
    }),
  );
} finally {
  if (installed) {
    try {
      uninstall(installPath);
    } catch {
      // Preserve the primary failure; residue checks below still fail closed.
    }
  }
  if (completed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`[nsis-upgrade] retained failed fixture for inspection: ${root}`);
}

function regularFile(value) {
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing installer: ${resolved}`);
  return resolved;
}

function appExecutable(directory) {
  return regularFile(path.join(directory, "Pi Agent Desktop.exe"));
}

function fileVersion(file) {
  const escaped = file.replaceAll("'", "''");
  return execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function install(installer, directory) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(installer, ["/S", `/D=${directory}`], {
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
    });
    if (!result.error && !result.signal && result.status === 0) return;

    const accessViolation = result.status === 0xc0000005;
    const installDirectoryRemainsEmpty =
      !fs.existsSync(directory) || fs.readdirSync(directory, { withFileTypes: true }).length === 0;
    if (!accessViolation || !installDirectoryRemainsEmpty || attempt === maxAttempts) {
      throw new Error(
        `installer failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr ?? ""}`,
        { cause: result.error },
      );
    }

    console.warn(
      `[nsis-upgrade] installer access violation before writing files; retrying (${attempt}/${maxAttempts})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function uninstall(directory) {
  const uninstallers = fs
    .readdirSync(directory)
    .filter((name) => /^Uninstall.*\.exe$/iu.test(name))
    .map((name) => path.join(directory, name));
  assert.equal(uninstallers.length, 1, "installed layout must contain exactly one official uninstaller");
  const result = spawnSync(uninstallers[0], ["/currentuser", "/S"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `uninstaller failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
}

function validateStartup(executable, isolatedRoot, expectedVersion, phase) {
  const userData = path.join(isolatedRoot, "user-data");
  const result = spawnSync(
    executable,
    [`--user-data-dir=${userData}`, "--validate-packaged-startup", "--disable-gpu"],
    {
      cwd: path.dirname(executable),
      env: {
        ...process.env,
        HOME: isolatedRoot,
        USERPROFILE: isolatedRoot,
        APPDATA: path.join(isolatedRoot, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(isolatedRoot, "AppData", "Local"),
        TMP: isolatedRoot,
        TEMP: isolatedRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `${phase} packaged startup failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
  const reportFiles = walkFiles(isolatedRoot).filter((file) => path.basename(file) === "packaged-startup-check.json");
  assert.equal(reportFiles.length, 1, `${phase} startup must write exactly one report`);
  const report = JSON.parse(fs.readFileSync(reportFiles[0], "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.appVersion, expectedVersion);
  assert.equal(report.platformArch, "win32-x64");
  assert.equal(report.rendererReady, true);
  assert.equal(report.hostReady, true);
  assert.equal(report.hostAckRevision, report.revision);
  return { phase, appVersion: report.appVersion, piVersion: report.piVersion, hostAckRevision: report.hostAckRevision };
}

async function verifyInstalledHelper(directory) {
  const helperRoot = path.join(directory, "resources", "managed-process", "win32-x64");
  const manifest = JSON.parse(fs.readFileSync(path.join(helperRoot, "manifest.json"), "utf8"));
  const executable = regularFile(path.join(helperRoot, "pi-managed-process-helper.exe"));
  assert.equal(sha256(executable), manifest.sha256);
  assert.equal(manifest.provenance, "release-authoritative");
  const selfTest = spawnSync(executable, ["--self-test-json-v1"], { encoding: "utf8", windowsHide: true });
  assert.equal(selfTest.status, 0);
  const result = JSON.parse(selfTest.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.buildId, manifest.buildId);
  const fileLock = await verifyInstalledHelperLock(executable);
  return { buildId: manifest.buildId, sha256: manifest.sha256, provenance: manifest.provenance, fileLock };
}

async function verifyInstalledHelperLock(executable) {
  const probe = `${executable}.replaceability-probe-${process.pid}`;
  const child = spawn(executable, ["--owner-stdio-v1"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await once(child, "spawn");
  await waitForInstalledHelperHello(child);
  let runningRenameFailed = false;
  try {
    try {
      fs.renameSync(executable, probe);
    } catch {
      runningRenameFailed = true;
    }
    if (fs.existsSync(probe) && !fs.existsSync(executable)) fs.renameSync(probe, executable);
    assert.equal(runningRenameFailed, true, "running installed helper must prevent replacement");
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      let timer;
      try {
        await Promise.race([
          once(child, "exit"),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("installed helper did not exit after termination")), 10_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  const deadline = Date.now() + 20_000;
  let replaceable = false;
  while (!replaceable && Date.now() <= deadline) {
    try {
      fs.renameSync(executable, probe);
      fs.renameSync(probe, executable);
      replaceable = true;
    } catch {
      if (fs.existsSync(probe) && !fs.existsSync(executable)) fs.renameSync(probe, executable);
      if (Date.now() < deadline) sleepSync(100);
    }
  }
  assert.equal(replaceable, true, "stopped installed helper must become replaceable");
  return { lockedWhileRunning: true, replaceableAfterExit: true };
}

function waitForInstalledHelperHello(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("installed helper did not emit HELLO")), 5_000);
    const onData = () => finish();
    const onExit = (code) => finish(new Error(`installed helper exited before HELLO (${code ?? "unknown"})`));
    const onError = (error) => finish(error);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function assertCleanUserInstallState(timeoutMs = 0) {
  const script = String.raw`
$entries=@(
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
  Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
  Get-ItemProperty 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
)|Where-Object{$_.DisplayName -like 'Pi Agent Desktop*'}
$shortcut=Join-Path ([Environment]::GetFolderPath('Programs')) 'Pi Agent Desktop.lnk'
$processes=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('Pi Agent Desktop.exe','pi-managed-process-helper.exe')})
[pscustomobject]@{entries=@($entries).Count;shortcut=(Test-Path -LiteralPath $shortcut);processes=$processes.Count}|ConvertTo-Json -Compress`;
  const expected = { entries: 0, shortcut: false, processes: 0 };
  const deadline = Date.now() + timeoutMs;
  let state;
  let pending = true;
  while (pending) {
    state = JSON.parse(
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
      }),
    );
    if (isDeepStrictEqual(state, expected)) return;
    pending = Date.now() < deadline;
    if (pending) sleepSync(250);
  }
  assert.deepEqual(state, expected, "NSIS test requires a clean user install state");
}

function assertNoMaterialInstallResidue(directory, timeoutMs = 0) {
  const deadline = Date.now() + timeoutMs;
  let entries;
  let pending = true;
  while (pending) {
    entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    if (entries.length === 0) return;
    pending = Date.now() < deadline;
    if (pending) sleepSync(250);
  }
  assert.deepEqual(entries, [], "official uninstall must leave no material install residue");
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}
