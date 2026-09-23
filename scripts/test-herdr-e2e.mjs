#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const OFFICIAL_MACOS_ARM64_SHA256 = "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574";
const binary = process.env.HERDR_E2E_BINARY;
if (!binary || !path.isAbsolute(binary) || !existsSync(binary)) {
  throw new Error("Set HERDR_E2E_BINARY to an absolute Herdr v0.8.2 executable path.");
}

const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
const tempRoot = mkdtempSync(path.join(tempBase, "pi-herdr-e2e-"));
const configHome = path.join(tempRoot, "xdg-config");
const stateHome = path.join(tempRoot, "xdg-state");
const testHome = path.join(tempRoot, "home");
const project = path.join(tempRoot, "project");
const sessionName = `pi-desktop-e2e-${process.pid}`;
const endpoint = path.join(configHome, "herdr", "sessions", sessionName, "herdr.sock");
for (const directory of [configHome, stateHome, testHome, project])
  mkdirSync(directory, { recursive: true, mode: 0o700 });

const childEnv = {
  PATH: "/usr/bin:/bin",
  HOME: testHome,
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  LANG: "C.UTF-8",
};
for (const key of Object.keys(childEnv)) {
  assert.doesNotMatch(key, /TOKEN|SECRET|KEY|CREDENTIAL|AUTH/i);
}
assert.equal(endpoint.startsWith(path.join(os.homedir(), ".config", "herdr")), false);
assert.equal(endpoint.startsWith(configHome), true);

let server;
let terminal;
let serverOutput = "";

function collect(child, callback) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => callback(chunk.toString("utf8")));
  }
}

function run(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: childEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`herdr ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`herdr ${args.join(" ")} exited ${code ?? signal}: ${stderr}`));
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function request(method, params, timeoutMs = 10_000) {
  const id = `e2e:${method}:${Date.now()}:${Math.random()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      assert.ok(buffer.length <= 4 * 1024 * 1024, "response exceeded 4 MiB");
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      assert.equal(response.id, id);
      if (response.error) finish(new Error(`${response.error.code}: ${response.error.message}`));
      else finish(undefined, response.result);
    });
    socket.once("error", finish);
  });
}

async function cleanup() {
  if (terminal && terminal.exitCode === null) {
    terminal.kill("SIGTERM");
    await Promise.race([once(terminal, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (terminal.exitCode === null && terminal.signalCode === null) {
      terminal.kill("SIGKILL");
      await Promise.race([once(terminal, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }
  if (server && server.exitCode === null) {
    try {
      await run(["--session", sessionName, "server", "stop"], 5_000);
    } catch {
      server.kill("SIGTERM");
    }
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }
  if (process.env.HERDR_E2E_KEEP_TEMP !== "1") rmSync(tempRoot, { recursive: true, force: true });
}

try {
  const version = await run(["--version"]);
  assert.match(version.stdout, /herdr 0\.8\.2\b/);
  const schema = JSON.parse((await run(["api", "schema", "--json"])).stdout);
  assert.equal(schema.protocol, 20);
  assert.equal(schema.schema_version, 1);
  const digest = await sha256(binary);
  if (process.platform === "darwin" && process.arch === "arm64") assert.equal(digest, OFFICIAL_MACOS_ARM64_SHA256);

  console.log(`isolated config: ${configHome}`);
  console.log(`isolated session: ${sessionName}`);
  console.log(`isolated socket: ${endpoint}`);
  console.log(`binary sha256: ${digest}`);

  server = spawn(binary, ["--session", sessionName, "server"], {
    env: childEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  collect(server, (value) => (serverOutput = `${serverOutput}${value}`.slice(-64 * 1024)));
  await waitFor(() => {
    if (server.exitCode !== null) throw new Error(`Herdr server exited before opening its socket: ${serverOutput}`);
    return existsSync(endpoint);
  }, "isolated API socket");
  await waitFor(() => serverOutput.includes(endpoint), "isolated API socket log");
  assert.match(serverOutput, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const socketInfo = statSync(endpoint);
  assert.equal(socketInfo.isSocket(), true);
  assert.equal(socketInfo.mode & 0o077, 0);

  const pong = await request("ping", {});
  assert.deepEqual(
    { type: pong.type, version: pong.version, protocol: pong.protocol },
    { type: "pong", version: "0.8.2", protocol: 20 },
  );
  const initial = await request("session.snapshot", {});
  assert.equal(initial.snapshot.workspaces.length, 0);

  const created = await request("workspace.create", { cwd: project, label: "pi-desktop-e2e", focus: true, env: {} });
  assert.equal(created.type, "workspace_created");
  assert.equal(created.root_pane.scroll.viewport_rows, 40);
  const paneId = created.root_pane.pane_id;
  const focusedWorkspace = await request("workspace.focus", { workspace_id: created.workspace.workspace_id });
  assert.equal(focusedWorkspace.workspace.workspace_id, created.workspace.workspace_id);
  const renamedWorkspace = await request("workspace.rename", {
    workspace_id: created.workspace.workspace_id,
    label: "pi-desktop-e2e-renamed-workspace",
  });
  assert.equal(renamedWorkspace.workspace.label, "pi-desktop-e2e-renamed-workspace");
  const focusedPane = await request("pane.focus", { pane_id: paneId });
  assert.equal(focusedPane.pane.pane_id, paneId);
  const renamedPane = await request("pane.rename", { pane_id: paneId, label: "pi-desktop-e2e-pane" });
  assert.equal(renamedPane.pane.label, "pi-desktop-e2e-pane");
  const processInfo = await request("pane.process_info", { pane_id: paneId });
  assert.equal(processInfo.process_info.pane_id, paneId);
  assert.equal(Array.isArray(processInfo.process_info.foreground_processes), true);

  const createdTab = await request("tab.create", {
    workspace_id: created.workspace.workspace_id,
    cwd: project,
    label: "pi-desktop-e2e-tab",
    focus: false,
    env: {},
  });
  assert.equal(createdTab.type, "tab_created");
  assert.equal(createdTab.tab.workspace_id, created.workspace.workspace_id);
  assert.equal(createdTab.root_pane.tab_id, createdTab.tab.tab_id);
  const focusedTab = await request("tab.focus", { tab_id: createdTab.tab.tab_id });
  assert.deepEqual(
    { type: focusedTab.type, tabId: focusedTab.tab.tab_id, workspaceId: focusedTab.tab.workspace_id },
    { type: "tab_info", tabId: createdTab.tab.tab_id, workspaceId: created.workspace.workspace_id },
  );
  const renamedTab = await request("tab.rename", { tab_id: createdTab.tab.tab_id, label: "pi-desktop-e2e-renamed" });
  assert.deepEqual(
    { type: renamedTab.type, tabId: renamedTab.tab.tab_id, label: renamedTab.tab.label },
    { type: "tab_info", tabId: createdTab.tab.tab_id, label: "pi-desktop-e2e-renamed" },
  );

  for (const [cols, rows] of [
    [80, 24],
    [104, 36],
  ]) {
    let observeBuffer = "";
    let observeFrameSeen = false;
    terminal = spawn(
      binary,
      [
        "--session",
        sessionName,
        "terminal",
        "session",
        "observe",
        paneId,
        "--cols",
        String(cols),
        "--rows",
        String(rows),
      ],
      { env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    terminal.stdout.on("data", (chunk) => {
      observeBuffer += chunk.toString("utf8");
      while (true) {
        const newline = observeBuffer.indexOf("\n");
        if (newline < 0) break;
        const frame = JSON.parse(observeBuffer.slice(0, newline));
        observeBuffer = observeBuffer.slice(newline + 1);
        if (frame.type !== "terminal.frame") continue;
        assert.equal(frame.encoding, "ansi");
        if (frame.width === cols && frame.height === rows) observeFrameSeen = true;
      }
    });
    await waitFor(() => observeFrameSeen, `observe terminal.frame ${cols}x${rows}`);
    terminal.kill("SIGTERM");
    await once(terminal, "exit");
    terminal = undefined;
  }

  let terminalBuffer = "";
  let terminalFrameSeen = false;
  terminal = spawn(
    binary,
    ["--session", sessionName, "terminal", "session", "control", paneId, "--takeover", "--cols", "80", "--rows", "24"],
    { env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  terminal.stdout.on("data", (chunk) => {
    terminalBuffer += chunk.toString("utf8");
    while (true) {
      const newline = terminalBuffer.indexOf("\n");
      if (newline < 0) break;
      const frame = JSON.parse(terminalBuffer.slice(0, newline));
      terminalBuffer = terminalBuffer.slice(newline + 1);
      if (frame.type === "terminal.frame") {
        assert.equal(frame.encoding, "ansi");
        terminalFrameSeen = true;
      }
    }
  });
  await waitFor(() => terminalFrameSeen, "terminal.frame");
  terminal.stdin.write(
    `${JSON.stringify({ type: "terminal.input", bytes: Buffer.from("printf 'PI_DESKTOP_HERDR_E2E_OK\\n'\\n").toString("base64") })}\n`,
  );
  await waitFor(async () => {
    const read = await request("pane.read", {
      pane_id: paneId,
      source: "recent_unwrapped",
      lines: 100,
      format: "text",
      strip_ansi: true,
    });
    return read.read.text.includes("PI_DESKTOP_HERDR_E2E_OK");
  }, "terminal input echo");
  const outputMatch = await request("pane.wait_for_output", {
    pane_id: paneId,
    source: "recent_unwrapped",
    match: { type: "substring", value: "PI_DESKTOP_HERDR_E2E_OK" },
    lines: 100,
    strip_ansi: true,
    timeout_ms: 2_000,
  });
  assert.equal(outputMatch.type, "output_matched");
  assert.equal(outputMatch.pane_id, paneId);
  terminal.stdin.write(`${JSON.stringify({ type: "terminal.release" })}\n`);
  terminal.stdin.end();
  await once(terminal, "exit");
  terminal = undefined;

  const afterRelease = await request("session.snapshot", {});
  assert.equal(
    afterRelease.snapshot.panes.some((pane) => pane.pane_id === paneId),
    true,
  );
  assert.equal((await request("pane.close", { pane_id: createdTab.root_pane.pane_id })).type, "ok");
  assert.equal((await request("workspace.close", { workspace_id: created.workspace.workspace_id })).type, "ok");
  const afterClose = await request("session.snapshot", {});
  assert.equal(afterClose.snapshot.workspaces.length, 0);
  console.log("Herdr v0.8.2 isolated socket + workspace + ANSI terminal control E2E: OK");
} finally {
  await cleanup();
}
