import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-session-index-"));
const sessionsRoot = path.join(fixtureRoot, "sessions");
const projectRoot = path.join(fixtureRoot, "project");
mkdirSync(path.join(sessionsRoot, "project"), { recursive: true });
mkdirSync(projectRoot, { recursive: true });
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { SessionIndex } = await importTestBundle("src/agent-host/session-index", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "session-index.ts")],
});

function writeSession(id, options = {}) {
  const filePath = path.join(sessionsRoot, "project", `${id}.jsonl`);
  const timestamp = options.timestamp ?? "2026-08-06T00:00:00.000Z";
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd: projectRoot,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    },
    {
      type: "message",
      id: `${id}-user`,
      parentId: null,
      timestamp,
      message: { role: "user", content: options.message ?? id, timestamp: Date.parse(timestamp) },
    },
  ];
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return filePath;
}

test("refreshAll reuses unchanged records and derives parent ids", async () => {
  const parentPath = writeSession("parent", { timestamp: "2026-08-01T00:00:00.000Z" });
  writeSession("child", { timestamp: "2026-08-02T00:00:00.000Z", parentSession: parentPath });
  const index = new SessionIndex();
  await Promise.all([index.refreshAll(), index.refreshAll()]);
  assert.equal(index.getMetrics().filesParsed, 2);
  const first = await index.getAll();
  assert.equal(first.find((session) => session.id === "child").parentSessionId, "parent");
  const piSessions = await SessionManager.listAll();
  for (const indexed of first) {
    const piSession = piSessions.find((session) => session.id === indexed.id);
    assert.ok(piSession);
    assert.equal(indexed.cwd, piSession.cwd);
    assert.equal(indexed.name, piSession.name);
    assert.equal(indexed.created, piSession.created.toISOString());
    assert.equal(indexed.modified, piSession.modified.toISOString());
    assert.equal(indexed.messageCount, piSession.messageCount);
    assert.equal(indexed.firstMessage, piSession.firstMessage);
  }

  await index.refreshAll();
  assert.deepEqual(index.getMetrics(), {
    filesDiscovered: 2,
    filesParsed: 0,
    filesReused: 2,
    invalidFiles: 0,
    totalMs: index.getMetrics().totalMs,
  });
});

test("refreshPath updates only one changed file and removePath deletes it", async () => {
  const index = new SessionIndex();
  await index.refreshAll();
  const parentPath = await index.resolvePath("parent");
  appendFileSync(
    parentPath,
    `${JSON.stringify({
      type: "session_info",
      id: "parent-name",
      parentId: "parent-user",
      timestamp: "2026-08-03T00:00:00.000Z",
      name: "renamed",
    })}\n`,
  );
  const updated = await index.refreshPath(parentPath);
  assert.equal(updated.name, "renamed");
  assert.equal(index.getMetrics().filesDiscovered, 1);
  assert.equal(index.getMetrics().filesParsed, 1);
  unlinkSync(parentPath);
  assert.equal(index.removePath(parentPath).id, "parent");
  assert.equal(await index.resolvePath("parent"), null);
});

test("unchanged invalid files are recorded without repeated parsing", async () => {
  const invalidPath = path.join(sessionsRoot, "project", "broken.jsonl");
  writeFileSync(invalidPath, "not json\n", "utf8");
  const index = new SessionIndex();
  await index.refreshAll();
  assert.equal(index.getMetrics().invalidFiles, 1);
  assert.equal(index.getMetrics().filesParsed >= 1, true);
  await index.refreshAll();
  assert.equal(index.getMetrics().filesParsed, 0);
  assert.equal(index.getMetrics().invalidFiles, 1);
});

test("a file appended during parsing is retried before its info is committed", async (t) => {
  const racingPath = writeSession("racing");
  const originalOpen = SessionManager.open;
  let appended = false;
  SessionManager.open = (filePath) => {
    const manager = originalOpen.call(SessionManager, filePath);
    if (filePath !== racingPath || appended) return manager;
    const originalGetEntries = manager.getEntries.bind(manager);
    manager.getEntries = () => {
      const result = originalGetEntries();
      if (!appended) {
        appended = true;
        appendFileSync(
          racingPath,
          `${JSON.stringify({
            type: "message",
            id: "racing-assistant",
            parentId: "racing-user",
            timestamp: "2026-08-06T00:00:01.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finished" }],
              provider: "test",
              model: "test",
              timestamp: Date.parse("2026-08-06T00:00:01.000Z"),
            },
          })}\n`,
        );
      }
      return result;
    };
    return manager;
  };
  t.after(() => {
    SessionManager.open = originalOpen;
  });

  const index = new SessionIndex();
  const info = await index.refreshPath(racingPath);
  assert.equal(appended, true);
  assert.equal(info.messageCount, 2);
  assert.equal(index.getMetrics().invalidFiles, 0);
});
