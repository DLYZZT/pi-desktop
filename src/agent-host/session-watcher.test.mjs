import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";

import { classifySessionWatchChange } from "./session-watch-policy.ts";

const { startSessionWatcher, sessionIndex } = await importTestBundle("pi-usage-session-watcher", {
  packages: "external",
  stdin: {
    contents:
      'export { startSessionWatcher } from "./session-watcher.ts"; export { sessionIndex } from "./session-index.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

function controlledWatcher(t, indexOverrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-watch-lifecycle-"));
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  const scheduled = new Set();
  const events = [];
  let onChange;
  let onError;
  let closed = 0;
  const stop = startSessionWatcher(
    { emit: (_topic, key, event) => events.push({ key, event }) },
    {
      index: {
        getByPath: () => null,
        refreshPath: async () => ({ id: "fixture", cwd: root }),
        refreshAll: async () => {},
        ...indexOverrides,
      },
      watch(_directory, listener) {
        onChange = listener;
        return {
          on(_event, listener) {
            onError = listener;
          },
          close() {
            closed++;
          },
        };
      },
      schedule(flush) {
        scheduled.add(flush);
        return () => scheduled.delete(flush);
      },
    },
  );
  t.after(() => {
    stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionsDir;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    events,
    stop,
    change: (name) => onChange("change", name),
    error: (error) => onError(error),
    pending: () => scheduled.size,
    closed: () => closed,
    async flush() {
      assert.equal(scheduled.size, 1, "expected exactly one pending refresh");
      const [flush] = scheduled;
      scheduled.delete(flush);
      await flush();
    },
  };
}

for (const mode of ["path", "all"]) {
  test(`stopping suppresses a late ${mode} refresh and ignores subsequent callbacks`, async (t) => {
    const gate = Promise.withResolvers();
    const fixture = controlledWatcher(t, {
      [mode === "path" ? "refreshPath" : "refreshAll"]: () => gate.promise,
    });
    fixture.change(mode === "path" ? "sessions/id.jsonl" : "settings.json");
    const flushing = fixture.flush();
    fixture.stop();
    gate.resolve({ id: "old-session", cwd: "/old-project" });
    await flushing;
    assert.deepEqual(fixture.events, []);
    fixture.change("sessions/id.jsonl");
    assert.equal(fixture.pending(), 0);
    fixture.stop();
    assert.equal(fixture.closed(), 1);
  });
}

test("events during a full refresh cause a later scan without overlapping scans", async (t) => {
  const gate = Promise.withResolvers();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const fixture = controlledWatcher(t, {
    async refreshAll() {
      active++;
      maxActive = Math.max(maxActive, active);
      if (++calls === 1) await gate.promise;
      active--;
    },
  });
  fixture.change("settings.json");
  const first = fixture.flush();
  fixture.change("settings.json");
  const overlapping = fixture.pending() ? fixture.flush() : undefined;
  gate.resolve();
  await first;
  await overlapping;
  if (fixture.pending()) await fixture.flush();
  assert.equal(calls, 2, "a change during the first snapshot needs its own scan");
  assert.equal(maxActive, 1);
  assert.equal(fixture.events.length, 2);
});

test("duplicate paths are coalesced and a full refresh subsumes pending path work", async (t) => {
  const calls = [];
  const fixture = controlledWatcher(t, {
    async refreshPath(file) {
      calls.push(path.basename(file));
      return { id: "fixture", cwd: "/project" };
    },
    async refreshAll() {
      calls.push("all");
    },
  });
  fixture.change("sessions/id.jsonl");
  fixture.change("sessions/id.jsonl");
  await fixture.flush();
  assert.deepEqual(calls, ["id.jsonl"]);
  fixture.change("sessions/id.jsonl");
  fixture.change("sessions/second.jsonl");
  fixture.change("settings.json");
  await fixture.flush();
  assert.deepEqual(calls, ["id.jsonl", "all"]);
  assert.equal(fixture.events.length, 2);
});

test("removed sessions retain their identity and unknown paths invalidate the full list", async (t) => {
  const fixture = controlledWatcher(t, {
    getByPath: (file) => (file.endsWith("removed.jsonl") ? { id: "removed", cwd: "/project" } : null),
    refreshPath: async () => null,
  });
  fixture.change("sessions/removed.jsonl");
  fixture.change("sessions/unknown.jsonl");
  await fixture.flush();
  assert.deepEqual(fixture.events, [
    { key: "removed", event: { cwd: "/project", sessionId: "removed", deleted: true } },
    { key: "*", event: { cwd: null, fullRefresh: true } },
  ]);
});

test("watch errors stop pending work and close the watcher once", (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = controlledWatcher(t);
  fixture.change("sessions/id.jsonl");
  fixture.error(new Error("watch fixture failure"));
  fixture.change("settings.json");
  fixture.stop();
  assert.equal(fixture.pending(), 0);
  assert.equal(fixture.closed(), 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(fixture.events, []);
});

test("a rejected refresh after shutdown does not publish an error fallback", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const gate = Promise.withResolvers();
  const fixture = controlledWatcher(t, { refreshAll: () => gate.promise });
  fixture.change("settings.json");
  const flushing = fixture.flush();
  fixture.stop();
  gate.reject(new Error("late refresh failure"));
  await flushing;
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(errors, []);
});

test("session watcher refreshes exact session files and rejects traversal", () => {
  const agentDir = path.resolve("/agent");
  const sessionsRoot = path.join(agentDir, "sessions");
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, "sessions/project/id.jsonl"), {
    kind: "refresh-path",
    path: path.join(sessionsRoot, "project", "id.jsonl"),
  });
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, "../outside.jsonl"), { kind: "ignore" });
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, "other/id.jsonl"), { kind: "ignore" });
});

test("ambiguous session metadata requests a full refresh while unrelated files are ignored", () => {
  const agentDir = path.resolve("/agent");
  const sessionsRoot = path.join(agentDir, "sessions");
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, null), { kind: "refresh-all" });
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, Buffer.from("settings.json")), {
    kind: "refresh-all",
  });
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, "session-cache.tmp"), { kind: "refresh-all" });
  assert.deepEqual(classifySessionWatchChange(agentDir, sessionsRoot, "notes.txt"), { kind: "ignore" });
});

test("an independent usage append notifies an idle session without adding a chat message", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-usage-watch-"));
  const agentDir = path.join(root, "agent");
  const sessionsRoot = path.join(agentDir, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  let stop = () => {};
  t.after(() => {
    stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionsDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionsDir;
    rmSync(root, { recursive: true, force: true });
  });

  const manager = SessionManager.create(root, sessionsRoot);
  manager.appendMessage({ role: "user", content: "Existing session", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Ready" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  assert.equal(existsSync(manager.getSessionFile()), true);
  const events = [];
  const trace = [];
  const startedAt = performance.now();
  const record = (phase, detail = {}) =>
    trace.push({ at: Math.round(performance.now() - startedAt), phase, ...detail });
  stop = startSessionWatcher(
    {
      emit(name, _key, event) {
        record("emit", { name, sessionId: event.sessionId, fullRefresh: event.fullRefresh });
        if (name === "sessions.changed") events.push(event);
      },
    },
    {
      watch(directory, onChange) {
        record("watch", { directory, realpath: realpathSync(directory) });
        const watcher = watch(directory, { recursive: true }, (event, filename) => {
          record("event", {
            event,
            filename: filename?.toString(),
            classified: classifySessionWatchChange(agentDir, sessionsRoot, filename),
          });
          onChange(event, filename);
        });
        watcher.on("error", (error) => record("watch-error", { message: error.message }));
        return watcher;
      },
      index: {
        getByPath: (file) => sessionIndex.getByPath(file),
        async refreshAll() {
          record("refresh-all-start");
          await sessionIndex.refreshAll();
          record("refresh-all-end");
        },
        async refreshPath(file) {
          record("refresh-path-start", { file });
          const session = await sessionIndex.refreshPath(file);
          record("refresh-path-end", { sessionId: session?.id });
          return session;
        },
      },
    },
  );
  record("append-start", { file: manager.getSessionFile() });
  manager.appendUsage("cache_warm", "anthropic", "fixture", {
    input: 7,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 7,
    cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  });
  record("append-end");
  for (let attempt = 0; attempt < 60 && events.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manager.getEntries().filter((entry) => entry.type === "message").length, 2);
  assert.equal(
    events.some((event) => event.sessionId === manager.getSessionId() || event.fullRefresh === true),
    true,
    JSON.stringify({ platform: process.platform, trace }, null, 2),
  );
});
