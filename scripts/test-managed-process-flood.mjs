#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import { ManagedProcessService } from "../src/agent-host/managed-process/service.ts";
import { applyManagedProcessOwnerIdentity } from "../src/agent-host/managed-process/owner-identity.ts";
import { resolveWindowsManagedProcessHelper } from "../src/shared/windows-managed-process-helper.ts";

const durationMs = Math.max(1_000, Number(process.env.PI_MANAGED_FLOOD_DURATION_MS ?? 60_000));
const processCount = Math.max(1, Number(process.env.PI_MANAGED_FLOOD_PROCESSES ?? 1));
const streamMode = process.env.PI_MANAGED_FLOOD_STREAMS ?? "stdout";
if (!Number.isSafeInteger(processCount) || processCount > 8) {
  throw new Error(`PI_MANAGED_FLOOD_PROCESSES must be an integer from 1 through 8, received ${processCount}`);
}
if (!new Set(["stdout", "both"]).has(streamMode)) {
  throw new Error(`PI_MANAGED_FLOOD_STREAMS must be stdout or both, received ${streamMode}`);
}
const cwd = await mkdtemp(path.join(tmpdir(), "pi-managed-flood-"));
const workerEntry = fileURLToPath(new URL("../src/agent-host/managed-process/worker.ts", import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bashCandidates = [
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  "D:\\tools\\w64devkit\\bin\\bash.exe",
];
const bashExecutable =
  process.platform === "win32" ? bashCandidates.find((candidate) => candidate && existsSync(candidate)) : "/bin/bash";
if (!bashExecutable) throw new Error("A native Windows Bash is required for the flood test");
let windowsHelper;
if (process.platform === "win32") {
  const script = `$p=Get-Process -Id ${process.pid} -ErrorAction Stop; [Console]::Out.Write([DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds())`;
  const startedAt = Number(
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  Object.defineProperty(process, "getCreationTime", { value: () => startedAt, configurable: true });
  applyManagedProcessOwnerIdentity({
    type: "managed-process-owner:init",
    version: 1,
    mainPid: process.pid,
    mainStartFingerprint: String(startedAt),
    mainImagePath: realpathSync.native(process.execPath),
    hostInstanceId: randomUUID(),
  });
  const resolution = resolveWindowsManagedProcessHelper({ isPackaged: false, resourcesPath: root, projectRoot: root });
  if (!resolution.ok) throw new Error(`Windows helper unavailable: ${resolution.errorCode}`);
  windowsHelper = resolution.descriptor;
}
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
          executable: bashExecutable,
          argvPrefix: [],
          binDir: path.dirname(bashExecutable),
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
      if (method === "managedProcesses.getSettings")
        return process.platform === "win32"
          ? {
              enabled: true,
              reaperReady: true,
              capability: {
                platform: "win32",
                arch: "x64",
                supported: true,
                ready: true,
                backend: "windows-job",
                helperBuildId: windowsHelper.buildId,
                helperProvenance: windowsHelper.provenance,
              },
              windowsHelper,
            }
          : { enabled: true, reaperReady: true };
      if (method === "managedProcesses.register") return { journalRevision: 1 };
      if (method === "managedProcesses.unregister") return { journalRevision: 2, removed: true };
      throw new Error(`unexpected parent call: ${method}`);
    },
  },
);

const producer = [
  // Match the helper's 16 KiB drain buffer: 16 KiB every 16 ms is exactly
  // 1 MiB/s while avoiding needless partial frames on constrained CI runners.
  'const line = "x".repeat(16 * 1024 - 1) + "\\n";',
  `const streams = ${streamMode === "both" ? "[process.stdout, process.stderr]" : "[process.stdout]"};`,
  'process.stdin.setEncoding("utf8");',
  "process.stdin.once('data', () => setInterval(() => { for (const stream of streams) stream.write(line); }, 16));",
  "console.log('FLOOD_READY');",
].join(" ");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const command = `${quote(process.execPath)} -e ${quote(producer)}`;
const rssBefore = process.memoryUsage().rss;
const ticks = [];
const slowTicks = [];
let ticker;

const started = [];
function consumeOutput(entry, output) {
  for (const record of output.records) {
    entry.seenStreams.add(record.stream);
    if (record.stream !== "system") continue;
    const dropped = record.text.match(/Backend dropped (\d+) bytes \/ (\d+) chunks\./u);
    if (!dropped) continue;
    entry.backendDroppedBytes += Number(dropped[1]);
    entry.backendDroppedChunks += Number(dropped[2]);
  }
  entry.cursor = output.nextCursor;
}

try {
  process.stdout.write(`${JSON.stringify({ progress: "flood-launch-start", processCount, streamMode })}\n`);
  const launched = await Promise.all(
    Array.from({ length: processCount }, async (_, index) => {
      const sessionId = `flood-session-${index + 1}`;
      const process = await service.startForAgent(sessionId, cwd, true, {
        command,
        kind: "watcher",
        label: `1 MiB/s flood ${index + 1}/${processCount}`,
        waitFor: { type: "output", contains: "FLOOD_READY", timeoutMs: 5_000 },
      });
      return {
        process,
        cursor: process.output.nextCursor,
        sessionId,
        seenStreams: new Set(),
        backendDroppedBytes: 0,
        backendDroppedChunks: 0,
      };
    }),
  );
  started.push(...launched);
  for (const entry of started) {
    service.write(
      { processId: entry.process.process.processId, runId: entry.process.runId, text: "GO" },
      entry.sessionId,
    );
  }
  process.stdout.write(`${JSON.stringify({ progress: "flood-running", durationMs })}\n`);
  let previousTick = performance.now();
  const tickerStartedAt = previousTick;
  ticker = setInterval(() => {
    const current = performance.now();
    const delayMs = Math.max(0, current - previousTick - 100);
    ticks.push(delayMs);
    if (delayMs >= 1_000) slowTicks.push({ elapsedMs: current - tickerStartedAt, delayMs });
    previousTick = current;
  }, 100);
  const readLatencies = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    for (const entry of started) {
      const readStarted = performance.now();
      const output = service.read(
        {
          processId: entry.process.process.processId,
          runId: entry.process.runId,
          cursor: entry.cursor,
          maxBytes: 128 * 1024,
        },
        entry.sessionId,
      );
      readLatencies.push(performance.now() - readStarted);
      consumeOutput(entry, output);
    }
    service.list(false, started[0].sessionId);
  }
  process.stdout.write(`${JSON.stringify({ progress: "flood-stopping" })}\n`);
  const stopStarted = performance.now();
  const stopped = await Promise.all(
    started.map((entry) =>
      service.stop(entry.process.process.processId, entry.process.runId, "graceful", "user", entry.sessionId),
    ),
  );
  const stopMs = performance.now() - stopStarted;
  process.stdout.write(`${JSON.stringify({ progress: "flood-stopped", stopMs })}\n`);
  clearInterval(ticker);
  ticks.sort((left, right) => left - right);
  readLatencies.sort((left, right) => left - right);
  const percentile = (values, quantile) =>
    values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
  for (const entry of started) {
    let output;
    do {
      output = service.read(
        {
          processId: entry.process.process.processId,
          runId: entry.process.runId,
          cursor: entry.cursor,
          maxBytes: 128 * 1024,
        },
        entry.sessionId,
      );
      consumeOutput(entry, output);
    } while (output.truncated);
  }
  const snapshots = started.map((entry) => service.get(entry.process.process.processId));
  const perProcess = snapshots.map((snapshot, index) => ({
    processId: snapshot.processId,
    state: stopped[index].state,
    retainedBytes: snapshot.output.retainedBytes,
    ringDroppedBytes: snapshot.output.droppedBytes,
    backendDroppedBytes: started[index].backendDroppedBytes,
    backendDroppedChunks: started[index].backendDroppedChunks,
    droppedBytes: snapshot.output.droppedBytes + started[index].backendDroppedBytes,
    streams: [...started[index].seenStreams].sort(),
  }));
  const result = {
    durationMs,
    processCount,
    streamMode,
    states: stopped.map((process) => process.state),
    retainedBytes: perProcess.reduce((total, process) => total + process.retainedBytes, 0),
    droppedBytes: perProcess.reduce((total, process) => total + process.droppedBytes, 0),
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    heartbeatDelayP99Ms: percentile(ticks, 0.99),
    heartbeatDelayMaxMs: Math.max(0, ...ticks),
    heartbeatSlowTicks: slowTicks,
    readLatencyP99Ms: percentile(readLatencies, 0.99),
    stopMs,
    perProcess,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (perProcess.some((process) => process.retainedBytes > 2 * 1024 * 1024)) {
    throw new Error("per-process output memory exceeded 2 MiB");
  }
  if (result.retainedBytes > processCount * 2 * 1024 * 1024) {
    throw new Error("global output memory exceeded the 2 MiB per-process budget");
  }
  if (result.droppedBytes <= 0 || (durationMs >= 10_000 && perProcess.some((process) => process.droppedBytes <= 0))) {
    throw new Error("flood processes did not all exercise ring eviction");
  }
  if (result.states.some((state) => state === "lost" || state === "failed")) {
    throw new Error("a flood process lost containment or failed");
  }
  if (
    streamMode === "both" &&
    perProcess.some((process) => !process.streams.includes("stdout") || !process.streams.includes("stderr"))
  ) {
    throw new Error("a dual-stream flood process did not expose both stdout and stderr");
  }
  if (result.heartbeatDelayP99Ms >= 5_000) throw new Error("heartbeat p99 delay exceeded 5 seconds");
  if (result.heartbeatDelayMaxMs >= 8_000) throw new Error("event-loop stall approached the 10 second timeout");
  if (result.stopMs >= 8_500) throw new Error("user stop exceeded lifecycle budget");
} finally {
  if (ticker) clearInterval(ticker);
  await service.stopAll("host");
}
