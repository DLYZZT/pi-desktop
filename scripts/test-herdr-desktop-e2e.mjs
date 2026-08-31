#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary, terminateProcessTree } from "./process-utils.mjs";
import { findSensitiveLeaks } from "./herdr-e2e-safety.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.HERDR_E2E_BINARY;
if (!binary || !path.isAbsolute(binary) || !existsSync(binary)) {
  throw new Error("Set HERDR_E2E_BINARY to an absolute Herdr v0.8.2 executable path.");
}
if (process.platform === "win32") throw new Error("Herdr Desktop E2E is currently gated to macOS and Linux.");

function isRosettaTranslated() {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  try {
    return execFileSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).trim() === "1";
  } catch {
    return false;
  }
}

const skipRosettaAgentDetection = process.env.HERDR_DESKTOP_E2E_SKIP_ROSETTA_AGENT === "1";
if (skipRosettaAgentDetection && !isRosettaTranslated()) {
  throw new Error("HERDR_DESKTOP_E2E_SKIP_ROSETTA_AGENT is valid only in a translated macOS x64 process.");
}

function terminalCycleCount() {
  const configured = process.env.HERDR_DESKTOP_E2E_CYCLES;
  if (configured === undefined) return process.env.HERDR_DESKTOP_E2E_STRESS === "1" ? 500 : 25;
  const cycles = Number(configured);
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 5_000) {
    throw new Error("HERDR_DESKTOP_E2E_CYCLES must be an integer between 1 and 5000.");
  }
  return cycles;
}

const tempRoot = mkdtempSync(path.join("/tmp", "pi-herdr-desktop-e2e-"));
const home = path.join(tempRoot, "home");
const configHome = path.join(tempRoot, "xdg-config");
const stateHome = path.join(tempRoot, "xdg-state");
const project = path.join(tempRoot, "project");
const userData = path.join(tempRoot, "user-data");
const agentDir = path.join(tempRoot, "agent");
const sessionDir = path.join(tempRoot, "pi-sessions");
const fixtureBin = path.join(tempRoot, "bin");
const sessionName = `desktop-e2e-${process.pid}`;
const endpoint = path.join(configHome, "herdr", "sessions", sessionName, "herdr.sock");
for (const directory of [home, configHome, stateHome, project, userData, agentDir, sessionDir, fixtureBin]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const fakePiExecutable = path.join(fixtureBin, "pi");
writeFileSync(
  fakePiExecutable,
  `#!${process.execPath}\nprocess.title = "pi";\nprocess.stdin.pipe(process.stdout);\nprocess.stdin.resume();\n`,
  { mode: 0o700 },
);
chmodSync(fakePiExecutable, 0o700);
copyFileSync(binary, path.join(fixtureBin, "herdr"));
chmodSync(path.join(fixtureBin, "herdr"), 0o700);

const linuxDisplayEnv =
  process.platform === "linux"
    ? Object.fromEntries(
        ["DISPLAY", "XAUTHORITY"].flatMap((name) =>
          typeof process.env[name] === "string" && process.env[name] ? [[name, process.env[name]]] : [],
        ),
      )
    : {};
const linuxElectronArguments = process.platform === "linux" ? ["--disable-gpu"] : [];
const isolatedEnv = {
  PATH: `${fixtureBin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  HOME: home,
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: sessionDir,
  PI_OFFLINE: "1",
  LANG: process.env.LANG ?? "C.UTF-8",
  ...linuxDisplayEnv,
};
assert.equal(endpoint.startsWith(path.join(os.homedir(), ".config", "herdr")), false);

let herdrServer;
let electron;
let cdp;
let serverOutput = "";

function log(message) {
  console.log(`[herdr-desktop-e2e] ${message}`);
}

async function waitFor(label, read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let latestError;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
      latestError = undefined;
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}: ${latestError instanceof Error ? latestError.message : JSON.stringify(latest)}`,
  );
}

function runHerdr(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: isolatedEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Herdr command timed out: ${args[0] ?? "unknown"}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Herdr command failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

function requestHerdr(method, params, timeoutMs = 10_000) {
  const id = `desktop-e2e:${Date.now()}:${Math.random()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let buffer = Buffer.alloc(0);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error(`${method} exceeded 4 MiB`));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      if (response.id !== id) return finish(new Error(`${method} response id mismatch`));
      if (response.error) return finish(new Error(`${response.error.code}: ${response.error.message}`));
      finish(undefined, response.result);
    });
    socket.once("error", (error) => finish(error));
  });
}

async function startHerdrServer() {
  herdrServer = spawn(binary, ["--session", sessionName, "server"], {
    env: isolatedEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [herdrServer.stdout, herdrServer.stderr]) {
    stream.on("data", (chunk) => (serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384)));
  }
  await waitFor(
    "isolated Herdr socket",
    () => {
      if (herdrServer.exitCode !== null) throw new Error(`Herdr server exited: ${serverOutput.slice(-300)}`);
      return existsSync(endpoint);
    },
    Boolean,
  );
  const info = statSync(endpoint);
  assert.equal(info.isSocket(), true);
  assert.equal(info.mode & 0o077, 0);
}

async function stopHerdrServer() {
  if (!herdrServer || herdrServer.exitCode !== null) return;
  try {
    await runHerdr(["--session", sessionName, "server", "stop"], 5_000);
  } catch {
    herdrServer.kill("SIGTERM");
  }
  await Promise.race([once(herdrServer, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  herdrServer = undefined;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve a CDP port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new globalThis.WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
    });
    return new CdpClient(socket);
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function discoverRenderer(port, startedAt, startupBudgetMs = 15_000) {
  const target = await waitFor(
    "Pi Desktop renderer target",
    async () => {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return undefined;
      const targets = await response.json();
      return targets.find((entry) => entry.type === "page" && /^app:\/\//.test(entry.url));
    },
    Boolean,
    startupBudgetMs,
  );
  assert.equal(Date.now() - startedAt < startupBudgetMs, true, "Renderer missed the startup budget");
  return CdpClient.connect(target.webSocketDebuggerUrl);
}

async function startElectron(settings, startupBudgetMs = 15_000, executablePath = isolatedEnv.PATH) {
  writeFileSync(
    path.join(userData, "ui-state.json"),
    JSON.stringify({ backgroundMode: false, herdrSettings: settings }),
  );
  const port = await reservePort();
  const startedAt = Date.now();
  electron = spawn(
    resolveElectronBinary(root),
    [...linuxElectronArguments, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, root],
    {
      cwd: root,
      env: { ...isolatedEnv, PATH: executablePath, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let output = "";
  for (const stream of [electron.stdout, electron.stderr]) {
    stream.on("data", (chunk) => (output = `${output}${chunk.toString("utf8")}`.slice(-16_384)));
  }
  electron.once("exit", (code, signal) => {
    if (!cdp && code !== 0) log(`Electron exited before CDP (${code ?? signal}): ${output.slice(-500)}`);
  });
  cdp = await discoverRenderer(port, startedAt, startupBudgetMs);
  await cdp.command("Runtime.enable");
  return Date.now() - startedAt;
}

async function stopElectron() {
  const runningElectron = electron;
  if (!runningElectron || runningElectron.exitCode !== null || runningElectron.signalCode !== null) {
    cdp?.close();
    cdp = undefined;
    electron = undefined;
    return;
  }

  if (cdp) {
    await cdp.evaluate("window.close(); true").catch(() => undefined);
    cdp.close();
    cdp = undefined;
  }
  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      if (runningElectron.exitCode !== null || runningElectron.signalCode !== null) return resolve(true);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        runningElectron.off("exit", onExit);
        resolve(runningElectron.exitCode !== null || runningElectron.signalCode !== null);
      }, timeoutMs);
      runningElectron.once("exit", onExit);
    });
  if (!(await waitForExit(20_000))) {
    terminateProcessTree(runningElectron);
    if (!(await waitForExit(5_000))) terminateProcessTree(runningElectron, { signal: "SIGKILL" });
  }
  electron = undefined;
}

async function installRendererRpc() {
  await waitFor("preload bridge", () => cdp.evaluate("typeof window.piBridge === 'object'"), Boolean);
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("host port timeout")), 15000);
    const onPort = (event) => {
      const data = event.data;
      if (event.source !== window || (data !== "pi-desktop-host-port" && data?.channel !== "pi-desktop-host-port")) return;
      const port = event.ports[0];
      if (!port) return;
      clearTimeout(timeout);
      window.removeEventListener("message", onPort);
      const pending = new Map();
      const events = [];
      let nextId = 0;
      port.onmessage = (messageEvent) => {
        const message = messageEvent.data;
        if (message?.kind === "response") {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.ok) request.resolve(message.result);
          else request.reject(new Error((message.error?.code ? message.error.code + ": " : "") + (message.error?.message || "RPC failed")));
        } else if (message?.kind === "event") {
          const data = message.data;
          events.push({
            topic: message.topic,
            key: message.key,
            seq: data?.seq,
            full: data?.full,
            bytes: data?.bytes?.byteLength,
            state: data?.state,
            paneId: data?.paneId,
          });
          if (events.length > 2000) events.splice(0, events.length - 2000);
        }
      };
      port.start();
      globalThis.__piDesktopE2E = {
        call(method, params) {
          const id = "e2e-" + (++nextId);
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
            port.postMessage({ kind: "request", id, method, params });
          });
        },
        subscribe(topic, key = "*") {
          const id = "sub-" + (++nextId);
          port.postMessage({ kind: "subscribe", id, topic, key });
          return id;
        },
        events,
      };
      resolve("ready");
    };
    window.addEventListener("message", onPort);
    window.piBridge.requestHostPort();
  })`);
}

function rpc(method, params) {
  const serialized = params === undefined ? "undefined" : JSON.stringify(params);
  return cdp.evaluate(`globalThis.__piDesktopE2E.call(${JSON.stringify(method)}, ${serialized})`);
}

function subscribe(topic, key = "*") {
  return cdp.evaluate(`globalThis.__piDesktopE2E.subscribe(${JSON.stringify(topic)}, ${JSON.stringify(key)})`);
}

function terminalInput(terminalId, text) {
  const bytes = [...Buffer.from(text, "utf8")];
  return cdp.evaluate(
    `globalThis.__piDesktopE2E.call("herdr.terminal.input", { terminalId: ${JSON.stringify(terminalId)}, bytes: new Uint8Array(${JSON.stringify(bytes)}) })`,
  );
}

async function waitForRuntime(status, timeoutMs = 20_000) {
  return waitFor(
    `Herdr runtime ${status}`,
    () => rpc("herdr.runtime.get"),
    (value) => value?.status === status,
    timeoutMs,
  );
}

function findAgentHostPid() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    })
    .filter(Boolean);
  const descendants = new Set([electron.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows.find(
    (row) =>
      descendants.has(row.pid) &&
      (row.command.includes("pi-agent-host") ||
        row.command.includes("agent-host.mjs") ||
        (row.command.includes("--type=utility") && row.command.includes("node.mojom.NodeService"))),
  )?.pid;
}

function processTreeMetrics(rootPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8" })
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)$/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuPercent: Number(match[4]) }
        : null;
    })
    .filter(Boolean);
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows
    .filter((row) => descendants.has(row.pid))
    .reduce(
      (total, row) => ({
        processes: total.processes + 1,
        rssKiB: total.rssKiB + row.rssKiB,
        cpuPercent: total.cpuPercent + row.cpuPercent,
      }),
      { processes: 0, rssKiB: 0, cpuPercent: 0 },
    );
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function run() {
  assert.match((await runHerdr(["--version"])).stdout, /herdr 0\.8\.2\b/);
  const catalog = JSON.parse(readFileSync(path.join(root, "build", "herdr", "runtime-catalog.json"), "utf8"));
  const schemaFile = path.join(tempRoot, "schema.json");
  writeFileSync(schemaFile, (await runHerdr(["api", "schema", "--json"])).stdout);
  assert.equal(await sha256(schemaFile), catalog.apiSchemaSha256);

  const blockedBinary = path.join(tempRoot, "blocked-herdr");
  writeFileSync(blockedBinary, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
  chmodSync(blockedBinary, 0o700);
  const blockedBin = path.join(tempRoot, "blocked-bin");
  mkdirSync(blockedBin, { recursive: true, mode: 0o700 });
  copyFileSync(blockedBinary, path.join(blockedBin, "herdr"));
  chmodSync(path.join(blockedBin, "herdr"), 0o700);
  const blockedPath = `${blockedBin}:${isolatedEnv.PATH}`;
  const blockedProbeSettings = {
    enabled: false,
    mode: "attach",
    sessionName,
    autoConnect: true,
    releaseControlOnViewClose: true,
  };
  const baselineStartupMs = await startElectron(blockedProbeSettings, 15_000, blockedPath);
  log(`disabled renderer startup baseline ${baselineStartupMs}ms`);
  await stopElectron();
  const blockedStartupMs = await startElectron({ ...blockedProbeSettings, enabled: true }, 15_000, blockedPath);
  log(`blocked-probe renderer startup ${blockedStartupMs}ms`);
  await stopElectron();
  const comparisonStartupMs = await startElectron(blockedProbeSettings, 15_000, blockedPath);
  log(`disabled renderer comparison baseline ${comparisonStartupMs}ms`);
  await stopElectron();
  const startupBaselineMs = Math.max(baselineStartupMs, comparisonStartupMs);
  assert.equal(
    blockedStartupMs <= startupBaselineMs + 500,
    true,
    `blocked Herdr probe added more than 500ms (${blockedStartupMs}ms vs ${startupBaselineMs}ms baseline envelope)`,
  );

  await startHerdrServer();
  const initial = await requestHerdr("workspace.create", {
    cwd: project,
    label: "desktop-e2e-initial",
    focus: true,
    env: {},
  });
  const initialPaneId = initial.root_pane.pane_id;

  const settings = {
    enabled: true,
    mode: "attach",
    sessionName,
    autoConnect: true,
    releaseControlOnViewClose: true,
  };
  const startupMs = await startElectron(settings);
  log(`production renderer startup ${startupMs}ms`);
  await installRendererRpc();
  const runtime = await waitForRuntime("ready");
  assert.equal(runtime.version, "0.8.2");
  assert.equal(runtime.protocol, 20);
  assert.equal(runtime.schemaVersion, 1);
  assert.equal(runtime.capabilities.terminalObserve, true);

  await rpc("system.allowRoot", { path: project });
  let fleet = await rpc("herdr.snapshot");
  assert.equal(
    fleet.panes.some((pane) => pane.id === initialPaneId),
    true,
  );
  assert.equal(fleet.panes.filter((pane) => pane.agent).length, 0);

  const created = await rpc("herdr.workspace.create", { cwd: project, name: "desktop-e2e-product" });
  if (skipRosettaAgentDetection) {
    log("Rosetta limitation: skipped fake Pi process detection; native x64 CI must run Agent start/prompt/wait");
  } else {
    const startedAgent = await rpc("herdr.agent.start", { paneId: created.rootPaneId, kind: "pi" });
    assert.equal(startedAgent.paneId, created.rootPaneId);
    await waitFor(
      "Herdr agent interactive readiness",
      () => rpc("herdr.snapshot"),
      (value) => value?.panes?.find((pane) => pane.id === created.rootPaneId)?.agent?.interactiveReady === true,
    );
    await rpc("herdr.agent.prompt", { paneId: created.rootPaneId, prompt: "PI_HERDR_AGENT_PROMPT_OK" });
    const waitedAgent = await rpc("herdr.agent.wait", {
      paneId: created.rootPaneId,
      states: ["idle", "working", "blocked", "done", "unknown"],
      timeoutMs: 5_000,
      requestId: `desktop-e2e-wait-${Date.now()}`,
    });
    assert.equal(typeof waitedAgent.state, "string");
    await waitFor(
      "Herdr agent prompt echo",
      () => rpc("herdr.pane.read", { paneId: created.rootPaneId, maxBytes: 16_384 }),
      (value) => value?.text?.includes("PI_HERDR_AGENT_PROMPT_OK"),
    );
  }
  const paneIds = [created.rootPaneId];
  for (let index = 1; index < 8; index += 1) {
    const split = await rpc("herdr.pane.split", {
      paneId: created.rootPaneId,
      direction: index % 2 === 0 ? "horizontal" : "vertical",
    });
    paneIds.push(split.paneId);
  }
  fleet = await rpc("herdr.snapshot");
  assert.equal(
    paneIds.every((paneId) => fleet.panes.some((pane) => pane.id === paneId)),
    true,
  );

  await subscribe("herdr.terminal.frame");
  await subscribe("herdr.terminal.status");
  for (const observerCount of [1, 4, 8]) {
    await cdp.evaluate("globalThis.__piDesktopE2E.events.splice(0)");
    const observers = await cdp.evaluate(
      `Promise.all(${JSON.stringify(paneIds.slice(0, observerCount))}.map((paneId) => globalThis.__piDesktopE2E.call("herdr.terminal.open", { paneId, mode: "observe", cols: 80, rows: 24 })))`,
    );
    assert.equal(observers.length, observerCount);
    const terminalIds = observers.map((terminal) => terminal.terminalId);
    await waitFor(
      `${observerCount} terminal frames`,
      () => cdp.evaluate("globalThis.__piDesktopE2E.events.filter((event) => event.topic === 'herdr.terminal.frame')"),
      (events) => terminalIds.every((terminalId) => events.some((event) => event.key === terminalId)),
    );
    await cdp.evaluate(
      `Promise.all(${JSON.stringify(observers)}.map((terminal) => globalThis.__piDesktopE2E.call("herdr.terminal.close", { terminalId: terminal.terminalId, release: true })))`,
    );
  }

  const control = await rpc("herdr.terminal.open", {
    paneId: created.rootPaneId,
    mode: "control",
    cols: 80,
    rows: 24,
    takeover: true,
  });
  await terminalInput(control.terminalId, "printf 'PI_DESKTOP_HERDR_PRODUCT_OK\\n'\n");
  await rpc("herdr.terminal.resize", { terminalId: control.terminalId, cols: 104, rows: 36 });
  await waitFor(
    "terminal control input",
    () => rpc("herdr.pane.read", { paneId: created.rootPaneId, maxBytes: 16_384 }),
    (value) => value?.text?.includes("PI_DESKTOP_HERDR_PRODUCT_OK"),
  );
  await rpc("herdr.terminal.close", { terminalId: control.terminalId, release: true });

  const metricsBeforeCycles = processTreeMetrics(electron.pid);
  const cycles = terminalCycleCount();
  for (let index = 0; index < cycles; index += 1) {
    const terminal = await rpc("herdr.terminal.open", {
      paneId: initialPaneId,
      mode: "observe",
      cols: 80,
      rows: 24,
    });
    await rpc("herdr.terminal.close", { terminalId: terminal.terminalId, release: true });
  }
  log(`terminal open/close cycles ${cycles}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const metricsAfterCycles = processTreeMetrics(electron.pid);
  const rendererTimerDelay = await cdp.evaluate(
    "new Promise((resolve) => { const started = performance.now(); setTimeout(() => resolve(performance.now() - started), 50); })",
  );
  const metrics = {
    before: metricsBeforeCycles,
    after: metricsAfterCycles,
    rssGrowthMiB: Math.round((metricsAfterCycles.rssKiB - metricsBeforeCycles.rssKiB) / 1024),
    rendererTimerDelayMs: Math.round(rendererTimerDelay),
  };
  log(`stress metrics ${JSON.stringify(metrics)}`);
  assert.equal(metricsAfterCycles.rssKiB - metricsBeforeCycles.rssKiB <= 256 * 1024, true, "RSS grew over 256 MiB");
  assert.equal(metricsAfterCycles.rssKiB <= 2 * 1024 * 1024, true, "Electron tree exceeded 2 GiB RSS");
  assert.equal(
    metricsAfterCycles.processes <= metricsBeforeCycles.processes,
    true,
    "Terminal cycles left an extra Pi-owned child process",
  );
  assert.equal(metricsAfterCycles.cpuPercent <= 400, true, "Electron tree remained above 400% CPU after cooldown");
  assert.equal(rendererTimerDelay <= 500, true, "Renderer event loop delay exceeded 500ms after stress");
  assert.equal(await cdp.evaluate("globalThis.__piDesktopE2E.events.length <= 2000"), true);

  await cdp.command("Page.enable");
  await cdp.command("Page.reload", { ignoreCache: true });
  await waitFor(
    "renderer reload",
    () => cdp.evaluate("document.readyState"),
    (value) => value === "complete",
  );
  await installRendererRpc();
  const runtimeBeforeHostCrash = await waitForRuntime("ready");

  const hostPid = findAgentHostPid();
  assert.equal(Number.isSafeInteger(hostPid), true, "Agent Host process was not found below production Main");
  process.kill(hostPid, "SIGKILL");
  await waitFor(
    "Agent Host crash detection",
    () => cdp.evaluate("window.piBridge.getHostStatus()"),
    (value) => value !== "ready",
  );
  await waitFor(
    "Agent Host crash recovery",
    () => cdp.evaluate("window.piBridge.getHostStatus()"),
    (value) => value === "ready",
    30_000,
  );
  await installRendererRpc();
  const runtimeAfterHostCrash = await waitForRuntime("ready", 30_000);
  assert.equal(
    runtimeAfterHostCrash.sourceGeneration > runtimeBeforeHostCrash.sourceGeneration,
    true,
    "Herdr Renderer snapshots did not advance to the replacement Host generation",
  );
  assert.equal(
    (await rpc("herdr.snapshot")).panes.some((pane) => pane.id === created.rootPaneId),
    true,
  );

  await stopHerdrServer();
  await waitFor(
    "runtime reconnecting after server stop",
    () => rpc("herdr.runtime.get"),
    (value) => value?.status === "reconnecting" || value?.status === "unavailable",
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(["reconnecting", "unavailable"].includes((await rpc("herdr.runtime.get")).status), true);
  await startHerdrServer();
  await waitForRuntime("ready", 30_000);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await stopHerdrServer();
    await waitFor(
      `one-second socket flap ${cycle + 1}`,
      () => rpc("herdr.runtime.get"),
      (value) => value?.status === "reconnecting" || value?.status === "unavailable",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await startHerdrServer();
    await waitForRuntime("ready", 30_000);
  }

  await rpc("herdr.runtime.disconnect");
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  assert.equal((await rpc("herdr.runtime.get")).status, "unavailable");
  assert.equal((await rpc("herdr.runtime.connect")).status, "ready");

  await stopElectron();
  await startElectron(settings);
  await installRendererRpc();
  await waitForRuntime("ready");
  fleet = await rpc("herdr.snapshot");
  assert.equal(
    fleet.panes.some((pane) => pane.id === created.rootPaneId),
    true,
    "Herdr pane did not survive app restart",
  );

  const leaks = await findSensitiveLeaks(
    [userData, sessionDir],
    [
      { label: "terminal marker", value: "PI_DESKTOP_HERDR_PRODUCT_OK" },
      { label: "agent prompt marker", value: "PI_HERDR_AGENT_PROMPT_OK" },
      { label: "Herdr endpoint", value: endpoint },
      { label: "isolated home", value: home },
    ],
  );
  assert.deepEqual(
    leaks.map(({ file, label }) => ({ file: path.relative(tempRoot, file), label })),
    [],
    "Sensitive Herdr values leaked into Desktop or Pi Session persistence",
  );
  log("production Main → Host → Renderer RPC, Fleet, Terminal, reconnect and restart: OK");
}

try {
  await run();
} finally {
  await stopElectron().catch(() => undefined);
  await stopHerdrServer().catch(() => undefined);
  if (process.env.HERDR_E2E_KEEP_TEMP !== "1") rmSync(tempRoot, { recursive: true, force: true });
  else log(`kept isolated fixture at ${tempRoot}`);
}
