import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeTest from "node:test";
import { importTestBundle } from "#test-bundle";

let modulePromise;
// Herdr integration is intentionally macOS/Linux-only until the Windows transport is implemented.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

async function loadSupervisor() {
  modulePromise ??= importTestBundle("src/main/herdr/managed-server", {
    packages: "external",
    absWorkingDir: new URL("../../..", import.meta.url).pathname,
    entryPoints: ["src/main/herdr/managed-server.ts"],
  });
  return modulePromise;
}

class FakeChild extends EventEmitter {
  pid = 42;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    globalThis.queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

class StubbornChild extends EventEmitter {
  pid = 43;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGKILL") globalThis.queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function target() {
  return { executable: "/private/herdr", sessionName: "desktop", endpoint: "/private/herdr.sock" };
}

test("Managed supervisor starts an owned foreground server and stops it through the matching Session", async () => {
  const { HerdrManagedServerSupervisor } = await loadSupervisor();
  const children = [];
  const spawns = [];
  let endpointReady = false;
  const supervisor = new HerdrManagedServerSupervisor({
    env: { XDG_CONFIG_HOME: "/private/config" },
    endpointPollMs: 1,
    spawn(executable, args, env) {
      spawns.push({ executable, args, env });
      const child = new FakeChild();
      children.push(child);
      globalThis.queueMicrotask(() => {
        endpointReady = true;
        child.emit("spawn");
      });
      return child;
    },
    async endpointReady() {
      return endpointReady;
    },
  });

  await supervisor.ensureRunning(target());
  assert.equal(supervisor.getState(), "running");
  assert.deepEqual(spawns, [
    {
      executable: "/private/herdr",
      args: ["--session", "desktop", "server"],
      env: { XDG_CONFIG_HOME: "/private/config" },
    },
  ]);

  await supervisor.stop();
  assert.equal(supervisor.getState(), "stopped");
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
});

test("Managed supervisor monitors unexpected exits and restarts with a bounded backoff", async () => {
  const { HerdrManagedServerSupervisor } = await loadSupervisor();
  const children = [];
  let endpointReady = false;
  const states = [];
  const supervisor = new HerdrManagedServerSupervisor({
    env: {},
    endpointPollMs: 1,
    restartDelayMs: () => 1,
    stableUptimeMs: 10_000,
    spawn() {
      const child = new FakeChild();
      children.push(child);
      globalThis.queueMicrotask(() => {
        endpointReady = true;
        child.emit("spawn");
      });
      return child;
    },
    async endpointReady() {
      return endpointReady;
    },
  });
  supervisor.setListener((event) => states.push(event.state));
  await supervisor.ensureRunning(target());

  endpointReady = false;
  children[0].emit("exit", 2, null);
  await waitFor(() => children.length === 2 && supervisor.getState() === "running", "managed restart");
  assert.deepEqual(states.slice(0, 4), ["starting", "running", "restarting", "restarting"]);
  await supervisor.stop();
});

test("Managed supervisor gives up after its restart budget and never adopts an external Session", async () => {
  const { HerdrManagedServerError, HerdrManagedServerSupervisor } = await loadSupervisor();
  let spawns = 0;
  const conflict = new HerdrManagedServerSupervisor({
    env: {},
    async endpointReady() {
      return true;
    },
    spawn() {
      spawns += 1;
      return new FakeChild();
    },
  });
  await assert.rejects(
    conflict.ensureRunning(target()),
    (error) => error instanceof HerdrManagedServerError && error.failure === "conflict",
  );
  assert.equal(spawns, 0);
  await conflict.stop();

  const children = [];
  let endpointReady = false;
  const failures = [];
  const supervisor = new HerdrManagedServerSupervisor({
    env: {},
    maxRestarts: 1,
    endpointPollMs: 1,
    restartDelayMs: () => 1,
    spawn() {
      const child = new FakeChild();
      children.push(child);
      globalThis.queueMicrotask(() => {
        endpointReady = true;
        child.emit("spawn");
      });
      return child;
    },
    async endpointReady() {
      return endpointReady;
    },
  });
  supervisor.setListener((event) => {
    if (event.failure) failures.push(event.failure);
  });
  await supervisor.ensureRunning(target());
  endpointReady = false;
  children[0].emit("exit", 1, null);
  await waitFor(() => children.length === 2, "single restart");
  endpointReady = false;
  children[1].emit("exit", 1, null);
  await waitFor(() => supervisor.getState() === "failed", "restart exhaustion");
  assert.equal(failures.at(-1), "restart-exhausted");
  await supervisor.stop();
});

test("Managed supervisor refuses an external Session that appears during restart backoff", async () => {
  const { HerdrManagedServerSupervisor } = await loadSupervisor();
  const children = [];
  const events = [];
  let endpointReady = false;
  const supervisor = new HerdrManagedServerSupervisor({
    env: {},
    endpointPollMs: 1,
    endpointOwnershipGraceMs: 1,
    restartDelayMs: () => 20,
    spawn() {
      const child = new FakeChild();
      children.push(child);
      globalThis.queueMicrotask(() => {
        endpointReady = true;
        child.emit("spawn");
      });
      return child;
    },
    async endpointReady() {
      return endpointReady;
    },
  });
  supervisor.setListener((event) => events.push(event));
  await supervisor.ensureRunning(target());

  endpointReady = false;
  children[0].emit("exit", 2, null);
  endpointReady = true;
  await waitFor(
    () => events.some((event) => event.state === "failed" && event.failure === "conflict"),
    "restart conflict",
  );
  assert.equal(children.length, 1, "an external endpoint must be rejected before spawning a replacement child");
  await supervisor.stop();
});

test("startup failure fully terminates a SIGTERM-ignoring child before spawning its replacement", async () => {
  const { HerdrManagedServerSupervisor } = await loadSupervisor();
  const children = [];
  const supervisor = new HerdrManagedServerSupervisor({
    env: {},
    startupTimeoutMs: 5,
    stopTimeoutMs: 5,
    forceStopTimeoutMs: 5,
    endpointPollMs: 1,
    restartDelayMs: () => 1,
    spawn() {
      const child = new StubbornChild();
      children.push(child);
      globalThis.queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    async endpointReady() {
      return false;
    },
  });

  await assert.rejects(supervisor.ensureRunning(target()), /did not become ready/);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  await waitFor(() => children.length === 2, "replacement after force-stop");
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  await supervisor.stop();
});
