import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
const {
  SessionIndex,
  getSessionContentSnapshot,
  buildSessionHistoryPage,
  buildHistoryRevision,
  buildSessionStats,
  makeFallbackTitle,
} = await importTestBundle("first-message-persistence", {
  packages: "external",
  stdin: {
    contents:
      'export {SessionIndex} from "./session-index.ts"; export {getSessionContentSnapshot} from "./session-content-cache.ts"; export {buildSessionHistoryPage, buildHistoryRevision} from "./session-history.ts"; export {buildSessionStats} from "./session-stats.ts"; export {makeFallbackTitle} from "./session-title.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("the first user message persists before any reply and remains readable, indexed and forkable", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-first-user-")),
    cwd = path.join(root, "project"),
    sessions = path.join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(sessions);
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const manager = SessionManager.create(cwd, sessions),
    filename = manager.getSessionFile();
  manager.appendModelChange("anthropic", "claude-sonnet-5-5");
  assert.equal(existsSync(filename), false, "Opening an empty chat must not create a session file");
  const userId = manager.appendMessage({
    role: "user",
    content: "Keep my first prompt after an aborted request",
    timestamp: Date.now(),
  });
  assert.equal(existsSync(filename), true);
  const original = readFileSync(filename);
  const snapshot = getSessionContentSnapshot(filename);
  const page = buildSessionHistoryPage({
    entries: snapshot.entries,
    leafId: userId,
    historyRevision: buildHistoryRevision(filename, manager.getSessionId()),
  });
  assert.equal(page.messages.length, 1);
  assert.match(page.messages[0].content, /Keep my first prompt/);
  const stats = buildSessionStats(snapshot.entries, { sessionId: manager.getSessionId() });
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 0);
  assert.equal(stats.cost, 0);
  assert.ok(makeFallbackTitle(page.messages[0].content));
  const index = new SessionIndex();
  const info = await index.refreshPath(filename);
  assert.equal(info.messageCount, 1);
  assert.match(info.firstMessage, /Keep my first prompt/);
  assert.deepEqual(readFileSync(filename), original, "Read paths must not migrate or repair the user-only file");
  const forkFile = manager.createBranchedSession(userId);
  assert.equal(existsSync(forkFile), true, "Forking before any assistant reply must write the copied user message");
  const fork = getSessionContentSnapshot(forkFile);
  assert.equal(fork.entries.filter((entry) => entry.type === "message").length, 1);
  const forkInfo = await index.refreshPath(forkFile);
  assert.equal(forkInfo.messageCount, 1);
  assert.notEqual(forkInfo.id, info.id);
});
