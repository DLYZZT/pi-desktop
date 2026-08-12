import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

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
