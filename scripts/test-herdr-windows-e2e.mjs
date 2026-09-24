#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importTestBundle } from "./test-bundle.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Herdr Windows E2E requires native Windows x64");
}

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "build", "herdr", "runtime-catalog.json");
const bundledRoot = path.join(root, "build", "herdr", "bin", "win32-x64");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-windows-e2e-"));
const tempRoot = fs.realpathSync.native(os.tmpdir());
const testRoot = fs.realpathSync.native(directory);
if (
  path.dirname(testRoot).toLowerCase() !== tempRoot.toLowerCase() ||
  !path.basename(testRoot).startsWith("pi-herdr-windows-e2e-")
) {
  throw new Error("Windows Herdr E2E directory escaped the expected temporary root");
}
const appData = path.join(directory, "Roaming");
const localAppData = path.join(directory, "Local");
const userDataDir = path.join(directory, "Desktop");
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(localAppData, { recursive: true });
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const sparsePath = [path.join(systemRoot, "System32"), systemRoot].join(";");
const env = {
  ...process.env,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: directory,
};
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "path") delete env[key];
}
env.Path = sparsePath;

let manager;
try {
  const { HerdrRuntimeManager } = await importTestBundle("scripts/herdr-windows-runtime-e2e", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/runtime-manager.ts"],
  });
  const { HerdrSocketClient } = await importTestBundle("scripts/herdr-windows-socket-e2e", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/socket-client.ts"],
  });
  const { discoverHerdrAgentClis } = await importTestBundle("scripts/herdr-windows-cli-e2e", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/agent-cli-discovery.ts"],
  });
  const agentBin = path.join(directory, ".local", "bin");
  fs.mkdirSync(agentBin, { recursive: true });
  const fakeAgentSource = path.join(directory, "pi.rs");
  fs.writeFileSync(
    fakeAgentSource,
    'use std::io::{self, BufRead};\nfn main() { println!("PI_DESKTOP_WIN_AGENT_READY"); for line in io::stdin().lock().lines() { if let Ok(line) = line { println!("{}", line); } else { break; } } }\n',
  );
  const nativeAgent = path.join(agentBin, "pi-native.exe");
  const canonicalAgent = path.join(agentBin, "pi.exe");
  execFileSync("rustc", [fakeAgentSource, "-o", nativeAgent], { timeout: 30_000 });
  fs.copyFileSync(nativeAgent, canonicalAgent);
  let cliSnapshot = await discoverHerdrAgentClis({
    homeDir: directory,
    userDataDir,
    platform: "win32",
    env,
    persistentPath: [],
  });
  assert.equal(cliSnapshot.selected.get("pi")?.source, "official");
  assert.equal(cliSnapshot.managedPath.includes(agentBin), false);
  manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "win32",
    arch: "x64",
    env,
    catalogPath,
    bundledRoot,
    agentCliEnvironmentProvider: () => ({
      revision: cliSnapshot.revision,
      diagnostics: cliSnapshot.diagnostics,
      managedPath: cliSnapshot.managedPath,
    }),
  });
  const settings = {
    enabled: true,
    mode: "managed",
    sessionName: "pi-desktop-windows-e2e",
    autoConnect: true,
    releaseControlOnViewClose: true,
  };

  assert.equal(manager.getManagedComponentState().canInstall, true, "pinned Windows bundle must be installable");
  await manager.installManagedRuntime();
  assert.equal(manager.getManagedComponentState().health, "healthy");
  const descriptor = await manager.initialize(settings);
  assert.equal(descriptor.error, undefined, descriptor.error?.code);
  assert.equal(descriptor.version, "0.8.2");
  assert.equal(descriptor.protocol, 20);
  assert.match(descriptor.endpoint, /^\\\\\.\\pipe\\[A-Za-z]:\\/u);
  const client = new HerdrSocketClient(descriptor.endpoint);
  const ping = await client.request({ method: "ping", params: {} });
  assert.equal(ping.type, "pong");
  assert.equal(ping.protocol, 20);
  const initial = await client.request({ method: "session.snapshot", params: {} });
  assert.equal(initial.snapshot.workspaces.length, 0);
  const created = await client.request({
    method: "workspace.create",
    params: { cwd: directory, label: "pi-desktop-windows-e2e", focus: true, env: {} },
    timeoutMs: 15_000,
  });
  assert.equal(created.type, "workspace_created");
  try {
    const pane = await client.request({
      method: "pane.read",
      params: { pane_id: created.root_pane.pane_id, source: "recent_unwrapped", lines: 40 },
    });
    assert.equal(pane.type, "pane_read");
    const agent = await client.request({
      method: "agent.start",
      params: {
        name: "pi",
        kind: "pi",
        pane_id: created.root_pane.pane_id,
        args: [],
        timeout_ms: 30_000,
      },
      timeoutMs: 35_000,
    });
    assert.equal(agent.type, "agent_started");
    let agentOutputVisible = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const read = await client.request({
        method: "pane.read",
        params: {
          pane_id: created.root_pane.pane_id,
          source: "recent_unwrapped",
          lines: 40,
          format: "text",
          strip_ansi: true,
        },
      });
      assert.equal(read.type, "pane_read");
      agentOutputVisible = read.read.text.length > pane.read.text.length;
      if (agentOutputVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(agentOutputVisible, true, "pane.read must expose Agent output for Windows text observation");
  } finally {
    const closed = await client.request({
      method: "workspace.close",
      params: { workspace_id: created.workspace.workspace_id },
    });
    assert.equal(closed.type, "ok");
  }

  fs.unlinkSync(canonicalAgent);
  fs.writeFileSync(path.join(agentBin, "pi.cmd"), '@echo off\r\n"%~dp0pi-native.exe" %*\r\n');
  cliSnapshot = await discoverHerdrAgentClis({
    homeDir: directory,
    userDataDir,
    platform: "win32",
    env,
    persistentPath: [],
  });
  assert.equal(cliSnapshot.selected.get("pi")?.launchForm, "windows-cmd");
  const staleEnvironment = await manager.refresh();
  assert.equal(staleEnvironment.agentCliRestartRequired, true);
  assert.equal(staleEnvironment.agentClis?.find((entry) => entry.kind === "pi")?.restartRequired, true);
  const restarted = await manager.restartManagedServer();
  assert.equal(restarted.error, undefined, restarted.error?.code);
  assert.equal(restarted.agentCliRestartRequired, undefined);
  assert.equal((await client.request({ method: "ping", params: {} })).type, "pong");
  const cmdWorkspace = await client.request({
    method: "workspace.create",
    params: { cwd: directory, label: "pi-desktop-windows-cmd-e2e", focus: true, env: {} },
    timeoutMs: 15_000,
  });
  assert.equal(cmdWorkspace.type, "workspace_created");
  try {
    const cmdAgent = await client.request({
      method: "agent.start",
      params: {
        name: "pi",
        kind: "pi",
        pane_id: cmdWorkspace.root_pane.pane_id,
        args: [],
        timeout_ms: 30_000,
      },
      timeoutMs: 35_000,
    });
    assert.equal(cmdAgent.type, "agent_started");
  } finally {
    const closed = await client.request({
      method: "workspace.close",
      params: { workspace_id: cmdWorkspace.workspace.workspace_id },
    });
    assert.equal(closed.type, "ok");
  }

  const attached = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "Attach"),
    platform: "win32",
    arch: "x64",
    env: { ...env, Path: `${path.dirname(descriptor.executable)};${sparsePath}` },
    catalogPath,
    bundledRoot,
  });
  const attach = await attached.initialize({ ...settings, mode: "attach" });
  assert.equal(attach.error, undefined);
  assert.equal(attach.endpoint, descriptor.endpoint);
  console.log(
    "OK: native Windows managed Herdr, named-pipe RPC, sparse-PATH EXE/CMD Agent start, restart, and Attach mode",
  );
} finally {
  try {
    if (manager) {
      await manager.stopManagedServer();
      await manager.removeManagedRuntime();
    }
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
