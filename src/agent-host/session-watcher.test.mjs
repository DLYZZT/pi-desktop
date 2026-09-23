import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";

import { classifySessionWatchChange } from "./session-watch-policy.ts";

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

  const { startSessionWatcher } = await importTestBundle("pi-usage-session-watcher", {
    packages: "external",
    entryPoints: [path.join(import.meta.dirname, "session-watcher.ts")],
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
  stop = startSessionWatcher({
    emit(name, _key, event) {
      if (name === "sessions.changed") events.push(event);
    },
  });
  manager.appendUsage("cache_warm", "anthropic", "fixture", {
    input: 7,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 7,
    cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  });
  for (let attempt = 0; attempt < 60 && events.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manager.getEntries().filter((entry) => entry.type === "message").length, 2);
  assert.equal(
    events.some((event) => event.sessionId === manager.getSessionId() || event.fullRefresh === true),
    true,
  );
});
