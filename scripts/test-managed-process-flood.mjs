#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import { ManagedProcessService } from "../src/agent-host/managed-process/service.ts";

const durationMs = Math.max(1_000, Number(process.env.PI_MANAGED_FLOOD_DURATION_MS ?? 60_000));
const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-flood-"));
const workerEntry = fileURLToPath(new URL("../src/agent-host/managed-process/worker.ts", import.meta.url));
const runtime = {
  async createExecutionContext() {
    return {
      inventoryRevision: 1,
      resolutionId: "flood-test",
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
const service = new ManagedProcessService(
  { emit() {} },
  {
    platform: process.platform,
    runtime,
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

const producer = [
  'const line = "x".repeat(1023) + "\\n";',
  "console.log('FLOOD_READY');",
  "setInterval(() => { for (let i = 0; i < 10; i += 1) process.stdout.write(line); }, 10);",
].join(" ");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const command = `${quote(process.execPath)} -e ${quote(producer)}`;
const rssBefore = process.memoryUsage().rss;
const ticks = [];
let previousTick = performance.now();
const ticker = setInterval(() => {
  const current = performance.now();
  ticks.push(Math.max(0, current - previousTick - 100));
  previousTick = current;
}, 100);

let started;
try {
  started = await service.startForAgent("flood-session", cwd, true, {
    command,
    kind: "watcher",
    label: "1 MiB/s flood",
    waitFor: { type: "output", contains: "FLOOD_READY", timeoutMs: 5_000 },
  });
  let cursor = started.output.nextCursor;
  const readLatencies = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    const readStarted = performance.now();
    const output = service.read(
      { processId: started.process.processId, runId: started.runId, cursor, maxBytes: 128 * 1024 },
      "flood-session",
    );
    readLatencies.push(performance.now() - readStarted);
    cursor = output.nextCursor;
    service.list(false, "flood-session");
  }
  const stopStarted = performance.now();
  const stopped = await service.stop(started.process.processId, started.runId, "graceful", "user", "flood-session");
  const stopMs = performance.now() - stopStarted;
  clearInterval(ticker);
  ticks.sort((left, right) => left - right);
  readLatencies.sort((left, right) => left - right);
  const percentile = (values, quantile) =>
    values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
  const snapshot = service.get(started.process.processId);
  const result = {
    durationMs,
    state: stopped.state,
    retainedBytes: snapshot.output.retainedBytes,
    droppedBytes: snapshot.output.droppedBytes,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    heartbeatDelayP99Ms: percentile(ticks, 0.99),
    heartbeatDelayMaxMs: Math.max(0, ...ticks),
    readLatencyP99Ms: percentile(readLatencies, 0.99),
    stopMs,
  };
  if (result.retainedBytes > 2 * 1024 * 1024) throw new Error("per-process output memory exceeded 2 MiB");
  if (result.droppedBytes <= 0) throw new Error("flood did not exercise ring eviction");
  if (result.heartbeatDelayP99Ms >= 1_000) throw new Error("heartbeat p99 delay exceeded 1 second");
  if (result.heartbeatDelayMaxMs >= 2_000) throw new Error("event-loop stall exceeded 2 seconds");
  if (result.stopMs >= 8_500) throw new Error("user stop exceeded lifecycle budget");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  clearInterval(ticker);
  if (started) await service.stopAll("host");
}
