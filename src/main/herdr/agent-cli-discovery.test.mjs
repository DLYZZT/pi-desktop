import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

async function loadDiscovery() {
  return importTestBundle("src/main/herdr/agent-cli-discovery-test", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/agent-cli-discovery.ts"],
  });
}

test("Agent CLI catalog exactly matches the current startable Herdr allowlist", async () => {
  const catalog = await importTestBundle("src/shared/herdr/agent-cli-catalog-test", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/shared/herdr/agent-cli-catalog.ts"],
  });
  assert.deepEqual(
    catalog.HERDR_AGENT_CLI_CATALOG.map(({ kind }) => kind),
    catalog.HERDR_STARTABLE_AGENT_KINDS,
  );
  assert.equal(
    catalog.HERDR_AGENT_CLI_CATALOG.some(({ command }) => command === "opencode2"),
    false,
  );
  assert.equal(
    catalog.HERDR_AGENT_CLI_CATALOG.some(({ command }) => command === "agent"),
    false,
  );
  assert.equal(
    catalog.HERDR_AGENT_CLI_CATALOG.some(({ command }) => command === "antigravity"),
    false,
  );
  assert.deepEqual(
    catalog.HERDR_AGENT_CLI_CATALOG.find(({ kind }) => kind === "agy"),
    {
      kind: "agy",
      command: "agy",
      posixHomeRelativeDirectories: [[".local", "bin"]],
      windowsHomeRelativeDirectories: [],
      windowsLocalAppDataRelativeDirectories: [["agy", "bin"]],
      environmentDirectories: [],
      runtimeHints: [],
    },
  );
});

test("sparse-PATH discovery finds official user locations without executing Agent binaries", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX launcher fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-agent-cli-discovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const userData = path.join(directory, "user-data");
  const localBin = path.join(home, ".local", "bin");
  const openCodeBin = path.join(home, ".opencode", "bin");
  const grokBin = path.join(home, ".grok", "bin");
  const marker = path.join(directory, "executed");
  for (const bin of [localBin, openCodeBin, grokBin]) mkdirSync(bin, { recursive: true });
  for (const [name, bin] of [
    ["codex", localBin],
    ["agy", localBin],
    ["opencode", openCodeBin],
    ["grok", grokBin],
  ]) {
    const executable = path.join(bin, name);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s' ${JSON.stringify(name)} >> ${JSON.stringify(marker)}\n`);
    chmodSync(executable, 0o700);
  }
  writeFileSync(path.join(openCodeBin, "opencode2"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(openCodeBin, "opencode2"), 0o700);

  const { discoverHerdrAgentClis } = await loadDiscovery();
  const snapshot = await discoverHerdrAgentClis({
    homeDir: home,
    userDataDir: userData,
    platform: process.platform,
    env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
  });

  assert.equal(existsSync(marker), false, "discovery must not execute --version or any Agent binary");
  for (const kind of ["codex", "agy", "opencode", "grok"]) {
    const diagnostic = snapshot.diagnostics.find((entry) => entry.kind === kind);
    assert.equal(diagnostic?.available, true, kind);
    assert.equal(["detected", "ambiguous"].includes(diagnostic?.status), true, kind);
  }
  assert.equal(snapshot.diagnostics.find((entry) => entry.kind === "gemini")?.status, "missing-locally");
  assert.equal(snapshot.managedPath.split(path.delimiter)[0], snapshot.overlayDirectory);
  assert.match(readFileSync(path.join(snapshot.overlayDirectory, "opencode"), "utf8"), /^#!\/bin\/sh\nexec /u);

  execFileSync(path.join(snapshot.overlayDirectory, "opencode"), [], { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(readFileSync(marker, "utf8"), "opencode");
});

test("Windows seed collection includes official per-user installation roots with a sparse Path", async () => {
  const { collectAgentCliDirectorySeeds } = await loadDiscovery();
  const seeds = await collectAgentCliDirectorySeeds({
    homeDir: "C:\\Users\\Ada",
    platform: "win32",
    env: {
      Path: "C:\\Windows\\System32;C:\\Windows",
      USERPROFILE: "C:\\Users\\Ada",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    },
  });
  const directories = seeds.map(({ directory }) => directory.toLowerCase());
  for (const expected of [
    "c:\\users\\ada\\.local\\bin",
    "c:\\users\\ada\\.grok\\bin",
    "c:\\users\\ada\\.opencode\\bin",
    "c:\\users\\ada\\bin",
    "c:\\users\\ada\\appdata\\local\\omp",
    "c:\\users\\ada\\appdata\\local\\agy\\bin",
    "c:\\users\\ada\\appdata\\local\\qwen-code\\bin",
    "c:\\users\\ada\\appdata\\local\\programs\\openai\\codex\\bin",
    "c:\\users\\ada\\appdata\\roaming\\npm",
  ]) {
    assert.equal(directories.includes(expected), true, expected);
  }
});

test("Windows sparse-Path discovery uses persistent Path without executing candidates or exposing user bins", async (t) => {
  if (process.platform !== "win32") return t.skip("native Windows path fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-agent-cli-windows-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const userData = path.join(directory, "user-data");
  const persistentBin = path.join(directory, "persistent-bin");
  const officialBin = path.join(home, ".opencode", "bin");
  for (const value of [persistentBin, officialBin]) mkdirSync(value, { recursive: true });
  const marker = path.join(directory, "executed");
  writeFileSync(path.join(persistentBin, "codex.cmd"), `@echo off\r\necho invoked>"${marker}"\r\n`);
  writeFileSync(path.join(officialBin, "opencode.exe"), "not-an-executable");
  const { discoverHerdrAgentClis } = await loadDiscovery();
  const snapshot = await discoverHerdrAgentClis({
    homeDir: home,
    userDataDir: userData,
    platform: "win32",
    env: {
      Path: "C:\\Windows\\System32;C:\\Windows",
      SystemRoot: "C:\\Windows",
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    },
    persistentPath: [persistentBin],
  });
  assert.equal(existsSync(marker), false);
  assert.equal(snapshot.selected.get("codex")?.source, "path");
  assert.equal(snapshot.diagnostics.find((entry) => entry.kind === "opencode")?.status, "detected");
  assert.equal(snapshot.managedPath.split(";")[0], snapshot.overlayDirectory);
  assert.equal(snapshot.managedPath.includes(persistentBin), false);
  assert.equal(snapshot.managedPath.includes(officialBin), false);
  execFileSync(
    process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/v:off", "/c", path.join(snapshot.overlayDirectory, "codex.cmd")],
    {
      env: { SystemRoot: "C:\\Windows", Path: snapshot.managedPath },
    },
  );
  assert.equal(existsSync(marker), true);
});

test("Windows long persistent Path keeps per-Agent and npm default directories in the bounded scan", async (t) => {
  if (process.platform !== "win32") return t.skip("native Windows path fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-agent-cli-windows-long-path-"));
  const safeDirectory = realpathSync.native(directory);
  assert.equal(path.dirname(safeDirectory).toLowerCase(), realpathSync.native(os.tmpdir()).toLowerCase());
  t.after(() => rmSync(safeDirectory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const userData = path.join(directory, "user-data");
  const appData = path.join(home, "AppData", "Roaming");
  const piBin = path.join(home, ".local", "bin");
  const npmBin = path.join(appData, "npm");
  mkdirSync(piBin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(path.join(piBin, "pi.exe"), "fixture");
  writeFileSync(path.join(npmBin, "gemini.cmd"), "@echo off\r\n");
  const persistentPath = Array.from({ length: 40 }, (_, index) => path.join(directory, `persistent-${index}`));
  const { discoverHerdrAgentClis } = await loadDiscovery();
  const snapshot = await discoverHerdrAgentClis({
    homeDir: home,
    userDataDir: userData,
    platform: "win32",
    env: {
      Path: "C:\\Windows\\System32;C:\\Windows",
      SystemRoot: "C:\\Windows",
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    },
    persistentPath,
  });
  assert.equal(snapshot.selected.get("pi")?.source, "official");
  assert.equal(snapshot.selected.get("gemini")?.source, "npm");
  assert.equal(snapshot.managedPath.includes(npmBin), false);
});
