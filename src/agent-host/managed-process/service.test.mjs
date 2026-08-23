import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { ManagedProcessError, ManagedProcessService } from "./service.ts";

let nextPid = 40_000;

class FakeWorker extends EventEmitter {
  pid = nextPid++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  connected = true;
  exitCode = null;
  signalCode = null;

  send(message) {
    if (message.type === "bootstrap") {
      setImmediate(() => {
        this.emit("message", { type: "started", shellPid: this.pid + 1 });
        this.stdout.write("READY http://127.0.0.1:4173/\n");
      });
      return true;
    }
    if (message.type === "stdin") {
      if (message.text) this.stdout.write(`echo:${message.text}\n`);
      if (message.close) this.emit("message", { type: "stdin-closed" });
      return true;
    }
    if (message.type === "stop") {
      setImmediate(() => {
        this.emit("message", { type: "exit", code: 0 });
        this.stdout.end();
        this.stderr.end();
        this.exitCode = 0;
        this.connected = false;
        this.emit("close", 0, null);
      });
      return true;
    }
    return false;
  }
}

class LateReadinessWorker extends FakeWorker {
  send(message) {
    if (message.type === "stop") this.stdout.write("LATE_READY http://127.0.0.1:4999/\n");
    return super.send(message);
  }
}

function runtimeFixture(beforeContext) {
  return {
    async createExecutionContext() {
      await beforeContext?.();
      return {
        inventoryRevision: 1,
        resolutionId: "test",
        nativeEnv: { PATH: process.env.PATH ?? "" },
        shellEnv: { PATH: process.env.PATH ?? "" },
        commands: {
          "shell.bash": {
            capability: "shell.bash",
            provider: "system",
            executable: "/bin/bash",
            argvPrefix: [],
            binDir: "/bin",
            cwdSemantics: "native",
            envPatch: {},
          },
        },
        summary: [],
      };
    },
    requireFromContext(_capability, context) {
      return context.commands["shell.bash"];
    },
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function waitUntil(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function harness() {
  const events = [];
  const parentCalls = [];
  const workers = [];
  const runtime = runtimeFixture();
  const service = new ManagedProcessService(
    { emit: (topic, key, data) => events.push({ topic, key, data }) },
    {
      platform: "darwin",
      runtime,
      spawnProcess: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      terminateProcessGroup: async () => true,
      parentCall: async (method, params) => {
        parentCalls.push({ method, params });
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        if (method === "managedProcesses.register") return { journalRevision: 1 };
        if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
        throw new Error(`unexpected parent call: ${method}`);
      },
      fingerprint: async (pid) => `fingerprint-${pid}`,
    },
  );
  return { service, events, parentCalls, workers };
}

test("starts, observes readiness, reads output, writes stdin and stops an owned process", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-service-"));
  const { service, parentCalls } = harness();
  const started = await service.startForAgent("session-a", cwd, true, {
    command: "npm run dev -- --host 127.0.0.1",
    label: "frontend",
    waitFor: { type: "loopback-url", timeoutMs: 1_000 },
  });
  assert.equal(started.state, "ready");
  assert.equal(started.endpoints[0].url, "http://127.0.0.1:4173/");
  assert.equal(
    parentCalls.some((entry) => entry.method === "managedProcesses.register"),
    true,
  );

  service.write({ processId: started.process.processId, runId: started.runId, text: "hello" }, "session-a");
  await new Promise((resolve) => setImmediate(resolve));
  const output = service.read({ processId: started.process.processId, runId: started.runId }, "session-a");
  assert.equal(
    output.records.some((record) => record.text === "echo:hello"),
    true,
  );
  await assert.rejects(
    async () => service.read({ processId: started.process.processId }, "session-b"),
    (error) => error instanceof ManagedProcessError && error.code === "PROCESS_NOT_FOUND",
  );

  const stopping = service.stop(started.process.processId, started.runId, "graceful", "agent", "session-a");
  assert.throws(
    () => service.write({ processId: started.process.processId, runId: started.runId, text: "late" }, "session-a"),
    (error) => error.code === "PROCESS_NOT_RUNNING",
  );
  const stopped = await stopping;
  assert.equal(stopped.state, "killed");
  assert.equal(stopped.exit.stoppedBy, "agent");
});

test("late readiness output cannot revive a stopping process", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-late-readiness-"));
  const service = new ManagedProcessService(
    { emit() {} },
    {
      platform: "darwin",
      runtime: runtimeFixture(),
      spawnProcess: () => new LateReadinessWorker(),
      terminateProcessGroup: async () => true,
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        if (method === "managedProcesses.register") return { journalRevision: 1 };
        if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
        throw new Error(`unexpected parent call: ${method}`);
      },
      fingerprint: async (pid) => `fingerprint-${pid}`,
    },
  );
  const keepAlive = setTimeout(() => {}, 500);
  const started = await service
    .startForAgent("session-a", cwd, true, {
      command: "npm run dev",
      waitFor: { type: "output", contains: "LATE_READY", timeoutMs: 250 },
    })
    .finally(() => clearTimeout(keepAlive));
  assert.equal(started.state, "running");

  const stopping = service.stop(started.process.processId, started.runId, "graceful", "user");
  assert.equal(service.get(started.process.processId).state, "stopping");
  assert.equal((await stopping).state, "killed");
});

test("user stop creates a barrier that only a user restart can clear", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-barrier-"));
  const { service } = harness();
  const started = await service.startForAgent("session-a", cwd, true, { command: "npm run dev" });
  await service.stop(started.process.processId, started.runId, "graceful", "user");
  await assert.rejects(
    service.restart(started.process.processId, started.runId, "agent", "session-a", true),
    (error) => error.code === "PROCESS_USER_STOPPED",
  );
  const restarted = await service.restart(started.process.processId, started.runId, "user");
  assert.equal(restarted.generation, 2);
  assert.equal(restarted.state, "running");
  await service.stop(restarted.processId, restarted.runId, "force", "user");
});

test("concurrent restarts create exactly one new generation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-restart-race-"));
  const { service } = harness();
  const started = await service.startForAgent("session-a", cwd, true, { command: "npm run dev" });
  const outcomes = await Promise.allSettled([
    service.restart(started.process.processId, started.runId, "agent", "session-a"),
    service.restart(started.process.processId, started.runId, "agent", "session-a"),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason.code, "PROCESS_STALE_RUN");
  const current = service.get(started.process.processId, "session-a");
  assert.equal(current.generation, 2);
  await service.stop(current.processId, current.runId, "force", "user");
});

test("feature, trust and platform gates fail before spawning", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-gates-"));
  const disabled = new ManagedProcessService(
    { emit() {} },
    {
      platform: "darwin",
      parentCall: async () => ({ enabled: false, reaperReady: true }),
    },
  );
  await assert.rejects(
    disabled.startForAgent("session", cwd, true, { command: "npm run dev" }),
    (error) => error.code === "PROCESS_FEATURE_DISABLED",
  );

  const windows = new ManagedProcessService({ emit() {} }, { platform: "win32", arch: "arm64" });
  await assert.rejects(
    windows.startForAgent("session", cwd, true, { command: "npm run dev" }),
    (error) => error.code === "PROCESS_PLATFORM_UNSUPPORTED",
  );

  const { service } = harness();
  await assert.rejects(
    service.startForAgent("session", cwd, false, { command: "npm run dev" }),
    (error) => error.code === "PROCESS_PROJECT_UNTRUSTED",
  );
});

test("stale runs, oversized waits and concurrent Agent waits fail closed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-races-"));
  const { service } = harness();
  const started = await service.startForAgent("session-a", cwd, true, { command: "npm run dev" });
  const staleRunId = "00000000-0000-4000-8000-000000000000";
  assert.throws(
    () => service.write({ processId: started.process.processId, runId: staleRunId, text: "x" }, "session-a"),
    (error) => error.code === "PROCESS_STALE_RUN",
  );
  await assert.rejects(
    service.stop(started.process.processId, staleRunId, "graceful", "agent", "session-a"),
    (error) => error.code === "PROCESS_STALE_RUN",
  );
  await assert.rejects(
    service.restart(started.process.processId, staleRunId, "agent", "session-a"),
    (error) => error.code === "PROCESS_STALE_RUN",
  );
  await assert.rejects(
    service.wait(
      {
        processId: started.process.processId,
        runId: started.runId,
        cursor: started.output.nextCursor,
        contains: "x".repeat(257),
      },
      "session-a",
    ),
    (error) => error.code === "PROCESS_LIMIT_REACHED",
  );

  const firstWait = service.wait(
    {
      processId: started.process.processId,
      runId: started.runId,
      cursor: started.output.nextCursor,
      timeoutMs: 100,
    },
    "session-a",
  );
  const keepAlive = setTimeout(() => {}, 200);
  await assert.rejects(
    service.wait(
      {
        processId: started.process.processId,
        runId: started.runId,
        cursor: started.output.nextCursor,
        timeoutMs: 100,
      },
      "session-a",
    ),
    (error) => error.code === "PROCESS_LIMIT_REACHED",
  );
  assert.equal((await firstWait).timedOut, true);
  clearTimeout(keepAlive);
  await service.stop(started.process.processId, started.runId, "force", "user");
});

test("cancelling start before spawn leaves no worker", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-abort-"));
  let enterContext;
  let releaseContext;
  const entered = new Promise((resolve) => {
    enterContext = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseContext = resolve;
  });
  let spawnCount = 0;
  const service = new ManagedProcessService(
    { emit() {} },
    {
      platform: "darwin",
      runtime: runtimeFixture(async () => {
        enterContext();
        await gate;
      }),
      spawnProcess: () => {
        spawnCount += 1;
        return new FakeWorker();
      },
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        throw new Error(`unexpected parent call: ${method}`);
      },
    },
  );
  const controller = new globalThis.AbortController();
  const start = service.startForAgent("session-a", cwd, true, { command: "npm run dev" }, controller.signal);
  await entered;
  controller.abort();
  releaseContext();
  await assert.rejects(start, (error) => error.code === "PROCESS_USER_STOPPED");
  assert.equal(spawnCount, 0);
  assert.equal(service.list(false, "session-a").processes.length, 0);
});

test("a synchronous POSIX worker spawn failure leaves no containment uncertainty", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-spawn-failure-"));
  let attempts = 0;
  const service = new ManagedProcessService(
    { emit() {} },
    {
      platform: "darwin",
      runtime: runtimeFixture(),
      spawnProcess: () => {
        attempts++;
        if (attempts === 1) throw new Error("spawn failed");
        return new FakeWorker();
      },
      terminateProcessGroup: async () => true,
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        if (method === "managedProcesses.register") return { journalRevision: 1 };
        if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
        throw new Error(`unexpected parent call: ${method}`);
      },
      fingerprint: async (pid) => `fingerprint-${pid}`,
    },
  );

  const startedAt = Date.now();
  await assert.rejects(
    service.startForAgent("session-a", cwd, true, { command: "npm run dev" }),
    (error) => error.code === "PROCESS_CONTAINMENT_UNAVAILABLE",
  );
  assert.ok(Date.now() - startedAt < 500, "spawn failure cleanup waited for a nonexistent worker");
  const started = await service.startForAgent("session-a", cwd, true, { command: "npm run dev" });
  assert.equal(started.state, "running");
  await service.stop(started.process.processId, started.runId, "force", "user");
});

test("user stop before spawn settles immediately as a stopped run", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-early-stop-"));
  let enterContext;
  let releaseContext;
  const entered = new Promise((resolve) => {
    enterContext = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseContext = resolve;
  });
  let created;
  let spawnCount = 0;
  const service = new ManagedProcessService(
    {
      emit(topic, _key, event) {
        if (topic === "processes.changed" && event.reason === "created") created = event;
      },
    },
    {
      platform: "darwin",
      runtime: runtimeFixture(async () => {
        enterContext();
        await gate;
      }),
      spawnProcess: () => {
        spawnCount += 1;
        return new FakeWorker();
      },
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        throw new Error(`unexpected parent call: ${method}`);
      },
    },
  );
  const start = service.startForAgent("session-a", cwd, true, { command: "npm run dev" }).catch((error) => error);
  await entered;
  assert.ok(created);

  const stop = service.stop(created.processId, created.runId, "graceful", "user");
  const stopped = await Promise.race([
    stop,
    new Promise((_, reject) => setTimeout(() => reject(new Error("early stop did not settle promptly")), 500)),
  ]);
  assert.equal(stopped.state, "killed");
  assert.equal(stopped.exit.reason, "stopped");
  assert.equal(stopped.exit.stoppedBy, "user");
  assert.equal(spawnCount, 0);

  releaseContext();
  const startError = await start;
  assert.equal(startError.code, "PROCESS_USER_STOPPED");
  assert.equal(service.get(created.processId).state, "killed");
});

test(
  "service drives the real worker and releases its verified process group",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-real-service-"));
    const reaperRecords = [];
    const runtime = {
      async createExecutionContext() {
        return {
          inventoryRevision: 1,
          resolutionId: "real-test",
          nativeEnv: { ...process.env },
          shellEnv: { ...process.env },
          commands: {
            "shell.bash": {
              capability: "shell.bash",
              provider: "system",
              executable: "/bin/bash",
              argvPrefix: [],
              binDir: "/bin",
              cwdSemantics: "native",
              envPatch: {},
            },
          },
          summary: [],
        };
      },
      requireFromContext(_capability, context) {
        return context.commands["shell.bash"];
      },
    };
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const service = new ManagedProcessService(
      { emit() {} },
      {
        platform: process.platform,
        runtime,
        workerEntryPath: workerEntry,
        workerExecArgv: ["--experimental-strip-types"],
        parentCall: async (method, params) => {
          if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
          if (method === "managedProcesses.register") {
            reaperRecords.push(params.record);
            return { journalRevision: 1 };
          }
          if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
          throw new Error(`unexpected parent call: ${method}`);
        },
      },
    );
    const appScript = [
      'console.log("READY http://127.0.0.1:43911/");',
      'process.stdin.on("data", (chunk) => process.stdout.write(`echo:${chunk}`));',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = `'${process.execPath.replaceAll("'", `'"'"'`)}' -e '${appScript.replaceAll("'", `'"'"'`)}'`;
    const started = await service.startForAgent("session-real", cwd, true, {
      command,
      waitFor: { type: "loopback-url", timeoutMs: 5_000 },
    });
    assert.equal(started.state, "ready");
    assert.equal(reaperRecords.length, 1);
    assert.equal("command" in reaperRecords[0], false);
    assert.equal("cwd" in reaperRecords[0], false);
    const pgid = reaperRecords[0].pgid;

    service.write({ processId: started.process.processId, runId: started.runId, text: "hello" }, "session-real");
    const output = await service.wait(
      {
        processId: started.process.processId,
        runId: started.runId,
        cursor: started.output.nextCursor,
        timeoutMs: 2_000,
      },
      "session-real",
    );
    assert.equal(
      output.records.some((record) => record.text === "echo:hello"),
      true,
    );
    await service.stop(started.process.processId, started.runId, "graceful", "agent", "session-real");
    assert.throws(
      () => process.kill(-pgid, 0),
      (error) => error.code === "ESRCH",
    );
  },
);

test(
  "service reaps an ignored-signal descendant after the root shell exits first",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-root-exit-"));
    const descendantFile = path.join(cwd, "descendant.pid");
    const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const service = new ManagedProcessService(
      { emit() {} },
      {
        platform: process.platform,
        runtime: runtimeFixture(),
        workerEntryPath: workerEntry,
        workerExecArgv: ["--experimental-strip-types"],
        parentCall: async (method) => {
          if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
          if (method === "managedProcesses.register") return { journalRevision: 1 };
          if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
          throw new Error(`unexpected parent call: ${method}`);
        },
      },
    );
    const descendantScript = [
      'const fs = require("node:fs");',
      'process.on("SIGINT", () => {});',
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const rootScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
      `const ready = setInterval(() => { if (!fs.existsSync(${JSON.stringify(descendantFile)})) return; clearInterval(ready); console.log("ROOT_EXIT"); setTimeout(() => process.exit(0), 300); }, 10);`,
    ].join(" ");
    const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
    let descendantPid;
    try {
      const started = await service.startForAgent("session-root-exit", cwd, true, {
        command: `${quote(process.execPath)} -e ${quote(rootScript)}`,
        waitFor: { type: "output", contains: "ROOT_EXIT", timeoutMs: 2_000 },
      });
      descendantPid = Number(await readFile(descendantFile, "utf8"));
      assert.equal(processExists(descendantPid), true);
      let cursor = started.output.nextCursor;
      let state = started.process.state;
      for (let attempt = 0; attempt < 5 && ["starting", "running", "ready"].includes(state); attempt += 1) {
        const window = await service.wait(
          {
            processId: started.process.processId,
            runId: started.runId,
            cursor,
            timeoutMs: 2_000,
          },
          "session-root-exit",
        );
        cursor = window.nextCursor;
        state = window.state;
      }
      await waitUntil(() => !processExists(descendantPid), 4_000, "ignored-signal descendant survived root exit");
      assert.equal(["exited", "failed", "killed"].includes(service.get(started.process.processId).state), true);
    } finally {
      await service.stopAll("host");
      if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  },
);
