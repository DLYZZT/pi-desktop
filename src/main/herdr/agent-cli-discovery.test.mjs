import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const kind of ["codex", "opencode", "grok"]) {
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
    "c:\\users\\ada\\appdata\\local\\qwen-code\\bin",
    "c:\\users\\ada\\appdata\\local\\programs\\openai\\codex\\bin",
    "c:\\users\\ada\\appdata\\roaming\\npm",
  ]) {
    assert.equal(directories.includes(expected), true, expected);
  }
});
