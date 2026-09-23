import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
// Herdr integration is intentionally macOS/Linux-only until the Windows transport is implemented.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
let modulePromise;

async function loadTerminalModule() {
  modulePromise ??= importTestBundle("src/agent-host/herdr/terminal-session", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/terminal-session.ts"],
  });
  return modulePromise;
}

function fakeTerminalCli(directory, lines, commandLogPath, { ignoreSigterm = false } = {}) {
  const executable = path.join(directory, "herdr");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      ignoreSigterm ? "process.on('SIGTERM', () => {});" : "process.on('SIGTERM', () => process.exit(0));",
      `for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n");`,
      "process.stdin.setEncoding('utf8');",
      commandLogPath
        ? `process.stdin.on('data', (chunk) => { require('fs').appendFileSync(${JSON.stringify(commandLogPath)}, chunk); if (chunk.includes('terminal.release')) process.exit(0); });`
        : "process.stdin.on('data', (chunk) => { if (chunk.includes('terminal.release')) process.exit(0); });",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  chmodSync(executable, 0o700);
  return executable;
}

function descriptor(executable) {
  return {
    revision: 1,
    enabled: true,
    mode: "attach",
    sessionName: "pi-desktop-test",
    autoConnect: true,
    releaseControlOnViewClose: true,
    executable,
    endpoint: "/tmp/unused.sock",
    binarySource: "custom",
    version: "0.8.2",
    protocol: 20,
    schemaVersion: 1,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for terminal event");
}

function fakeCrashRecovery(events = []) {
  return async (child, terminalId) => {
    events.push({ type: "registered", terminalId, pid: child.pid });
    return async () => {
      events.push({ type: "unregistered", terminalId, pid: child.pid });
    };
  };
}

test("terminal registry decodes ANSI frames, enforces read-only input, and releases children", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, [
    {
      type: "terminal.frame",
      seq: 1,
      encoding: "ansi",
      width: 80,
      height: 24,
      full: true,
      bytes: Buffer.from("\u001b[32mHERDR_OK\u001b[0m").toString("base64"),
    },
  ]);
  const events = [];
  const recoveryEvents = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(recoveryEvents),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const frame = await waitFor(() => events.find((event) => event.topic === "herdr.terminal.frame"));
  assert.equal(frame.key, session.terminalId);
  assert.equal(Buffer.from(frame.data.bytes).toString("utf8"), "\u001b[32mHERDR_OK\u001b[0m");
  assert.deepEqual(registry.diagnostics(), {
    streams: 1,
    controllers: 0,
    frames: 1,
    bytes: Buffer.byteLength("\u001b[32mHERDR_OK\u001b[0m"),
  });
  session.ack(1);
  assert.throws(
    () => session.input(new Uint8Array([65])),
    (error) => error.code === "HERDR_TERMINAL_NOT_CONTROLLER",
  );
  registry.close(session.terminalId, true);
  await waitFor(() => recoveryEvents.find((event) => event.type === "unregistered"));
  assert.deepEqual(
    recoveryEvents.map((event) => event.type),
    ["registered", "unregistered"],
  );
});

test("orphaned terminal controllers are released after the grace period", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-orphan-controller-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commandLogPath = path.join(directory, "commands.ndjson");
  const executable = fakeTerminalCli(directory, [], commandLogPath);
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, fakeCrashRecovery());
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24);

  registry.scheduleOrphanRelease(session.terminalId, 20);
  await waitFor(() => {
    try {
      registry.get(session.terminalId);
      return false;
    } catch (error) {
      return error.code === "HERDR_TERMINAL_NOT_FOUND";
    }
  });
  if (existsSync(commandLogPath)) {
    assert.match(readFileSync(commandLogPath, "utf8"), /"type":"terminal\.release"/);
  }
});

test("terminal control is single-owner and rate-limits renderer input", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-controller-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commandLogPath = path.join(directory, "commands.ndjson");
  const executable = fakeTerminalCli(directory, [], commandLogPath);
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, fakeCrashRecovery());
  t.after(() => registry.closeAll(true));
  const first = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24);
  first.resize(104, 36);
  const resizeCommand = await waitFor(() => {
    try {
      return readFileSync(commandLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((command) => command.type === "terminal.resize");
    } catch {
      return undefined;
    }
  });
  assert.deepEqual(resizeCommand, { type: "terminal.resize", cols: 104, rows: 36 });
  await assert.rejects(
    registry.open(descriptor(executable), "w1:p1", "control", 80, 24),
    (error) => error.code === "HERDR_TERMINAL_BUSY",
  );
  const block = new Uint8Array(64 * 1024);
  for (let index = 0; index < 4; index += 1) {
    first.input(block);
    await waitFor(() => {
      try {
        return (
          readFileSync(commandLogPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((command) => command.type === "terminal.input").length >=
          index + 1
        );
      } catch {
        return false;
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.throws(
    () => first.input(block),
    (error) => error.code === "HERDR_PROTOCOL_LIMIT_EXCEEDED",
  );
  const replacement = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24, true);
  assert.notEqual(replacement.terminalId, first.terminalId);
});

test("three malformed terminal records fail closed and evict the registry entry", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-malformed-terminal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, [{ nope: 1 }, { nope: 2 }, { nope: 3 }]);
  const events = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const failure = await waitFor(() =>
    events.find((event) => event.topic === "herdr.terminal.status" && event.data.state === "error"),
  );
  assert.equal(failure.data.error.code, "HERDR_TERMINAL_PROTOCOL");
  assert.equal(registry.diagnostics().recentErrorCode, "HERDR_TERMINAL_PROTOCOL");
  await waitFor(() => {
    try {
      registry.get(session.terminalId);
      return false;
    } catch (error) {
      return error.code === "HERDR_TERMINAL_NOT_FOUND";
    }
  });
});

test("terminal frame gaps fail closed and request a read-only recovery", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-gap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const frame = (seq, full) => ({
    type: "terminal.frame",
    seq,
    encoding: "ansi",
    width: 80,
    height: 24,
    full,
    bytes: Buffer.from(String(seq)).toString("base64"),
  });
  const executable = fakeTerminalCli(directory, [frame(1, true), frame(3, false)]);
  const events = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24);
  const failure = await waitFor(() =>
    events.find((event) => event.topic === "herdr.terminal.status" && event.data.state === "error"),
  );
  assert.equal(failure.data.error.code, "HERDR_TERMINAL_PROTOCOL");
  assert.equal(failure.data.recovery, "reopen-observe");
  assert.match(failure.data.error.message, /sequence has a gap/);
  await waitFor(() => {
    try {
      registry.get(session.terminalId);
      return false;
    } catch {
      return true;
    }
  });
});

test("one large stdout chunk stops at frame and byte backpressure boundaries", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-backpressure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lines = Array.from({ length: 100 }, (_, index) => ({
    type: "terminal.frame",
    seq: index + 1,
    encoding: "ansi",
    width: 80,
    height: 24,
    full: index === 0,
    bytes: Buffer.from(`frame-${index + 1}`).toString("base64"),
  }));
  const executable = fakeTerminalCli(directory, lines);
  const events = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const frameCount = () => events.filter((event) => event.topic === "herdr.terminal.frame").length;

  await waitFor(() => frameCount() === 32);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(frameCount(), 32);
  session.ack(32);
  await waitFor(() => frameCount() === 64);
  session.ack(64);
  await waitFor(() => frameCount() === 96);
  session.ack(96);
  await waitFor(() => frameCount() === 100);
  await registry.close(session.terminalId, true);
});

test("terminal frame bytes never cross the 8 MiB unacknowledged limit", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-byte-backpressure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const payload = Buffer.alloc(1_400_000, 0x41).toString("base64");
  const lines = Array.from({ length: 10 }, (_, index) => ({
    type: "terminal.frame",
    seq: index + 1,
    encoding: "ansi",
    width: 80,
    height: 24,
    full: index === 0,
    bytes: payload,
  }));
  const executable = fakeTerminalCli(directory, lines);
  const events = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const frames = () => events.filter((event) => event.topic === "herdr.terminal.frame");

  await waitFor(() => frames().length === 5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(frames().length, 5);
  assert.equal(frames().reduce((total, event) => total + event.data.bytes.byteLength, 0) <= 8 * 1024 * 1024, true);
  session.ack(5);
  await waitFor(() => frames().length === 10);
  await registry.close(session.terminalId, true);
});

test("terminal input queues bounded writes while backpressured and resumes after drain", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-input-drain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, []);
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, fakeCrashRecovery());
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24);

  const writes = [];
  let acceptWrites = false;
  session.child.stdin.write = (value) => {
    writes.push(String(value));
    return acceptWrites;
  };
  session.input(new Uint8Array(64 * 1024));
  session.input(new Uint8Array([1]));
  assert.equal(writes.length, 1, "the second command must wait for drain");
  acceptWrites = true;
  session.child.stdin.emit("drain");
  await waitFor(() => writes.length === 2);
  await registry.close(session.terminalId, true);
});

test("terminal input queue rejects commands beyond its encoded byte limit", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-input-queue-limit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, []);
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, fakeCrashRecovery());
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "control", 80, 24);

  session.child.stdin.write = () => false;
  const block = new Uint8Array(64 * 1024);
  session.input(block);
  session.input(block);
  assert.throws(
    () => session.input(block),
    (error) => error.code === "HERDR_PROTOCOL_LIMIT_EXCEEDED" && /backpressured/.test(error.message),
  );
  await registry.close(session.terminalId, true);
});

test("concurrent observe opens for one pane serialize and evict the superseded child", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-single-flight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, []);
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, fakeCrashRecovery());
  t.after(() => registry.closeAll(true));

  const firstPromise = registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const secondPromise = registry.open(descriptor(executable), "w1:p1", "observe", 100, 30);
  const first = await firstPromise;
  const second = await secondPromise;

  assert.notEqual(first.terminalId, second.terminalId);
  assert.throws(
    () => registry.get(first.terminalId),
    (error) => error.code === "HERDR_TERMINAL_NOT_FOUND",
  );
  assert.equal(registry.get(second.terminalId), second);
});

test("closeAll invalidates an opening terminal and any queued reopen", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-close-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(directory, []);
  let releaseRegistration;
  let registrations = 0;
  const registry = new HerdrTerminalRegistry({ emit: () => {} }, async () => {
    registrations += 1;
    await new Promise((resolve) => {
      releaseRegistration = resolve;
    });
    return async () => {};
  });
  t.after(() => registry.closeAll(true));

  const opening = registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  const queued = registry.open(descriptor(executable), "w1:p1", "observe", 100, 30);
  await waitFor(() => releaseRegistration);
  const closing = registry.closeAll(true);
  releaseRegistration();

  await closing;
  await assert.rejects(opening, (error) => error.code === "HERDR_ENDPOINT_UNAVAILABLE");
  await assert.rejects(queued, (error) => error.code === "HERDR_ENDPOINT_UNAVAILABLE");
  assert.equal(registrations, 1, "the queued reopen must be invalidated before spawning another child");
});

test("terminal close escalates when a child ignores SIGTERM and only then evicts the registry", async (t) => {
  const { HerdrTerminalRegistry } = await loadTerminalModule();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-terminal-force-kill-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeTerminalCli(
    directory,
    [
      {
        type: "terminal.frame",
        seq: 1,
        encoding: "ansi",
        width: 80,
        height: 24,
        full: true,
        bytes: Buffer.from("ready").toString("base64"),
      },
    ],
    undefined,
    { ignoreSigterm: true },
  );
  const recoveryEvents = [];
  const events = [];
  const registry = new HerdrTerminalRegistry(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    fakeCrashRecovery(recoveryEvents),
  );
  t.after(() => registry.closeAll(true));
  const session = await registry.open(descriptor(executable), "w1:p1", "observe", 80, 24);
  await waitFor(() => events.find((event) => event.topic === "herdr.terminal.frame"));
  const startedAt = Date.now();
  await registry.close(session.terminalId, true);
  const elapsed = Date.now() - startedAt;

  assert.equal(elapsed >= 1_800, true, `expected SIGKILL escalation, closed after ${elapsed} ms`);
  assert.throws(
    () => registry.get(session.terminalId),
    (error) => error.code === "HERDR_TERMINAL_NOT_FOUND",
  );
  assert.deepEqual(
    recoveryEvents.map((event) => event.type),
    ["registered", "unregistered"],
  );
});
