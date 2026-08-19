import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodedSessionCwdDirName, rewriteSessionHeaderCwdText } from "../shared/session-cwd.ts";

const isolatedAgentDirectory = mkdtempSync(path.join(tmpdir(), "pi-relocate-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolatedAgentDirectory, "sessions");

test("rewriteSessionHeaderCwdText replaces only the header cwd", () => {
  const raw = [
    JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "F:/old" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" }),
    "",
  ].join("\n");
  const next = rewriteSessionHeaderCwdText(raw, "F:/new");
  const [headerLine, messageLine] = next.split("\n");
  assert.equal(JSON.parse(headerLine).cwd, "F:/new");
  assert.equal(JSON.parse(headerLine).id, "abc");
  assert.equal(messageLine, raw.split("\n")[1]);
});

test("encodedSessionCwdDirName matches pi session folder encoding", () => {
  assert.equal(encodedSessionCwdDirName("F:\\Project\\foo"), "--F--Project-foo--");
  assert.equal(encodedSessionCwdDirName("/home/doe/app"), "--home-doe-app--");
});

test("relocateSessionFile moves jsonl and appends cwd notice", async () => {
  const { relocateSessionFile, defaultSessionDirForCwd } = await import("./session-relocate.ts");
  const fromCwd = path.join(isolatedAgentDirectory, "from");
  const toCwd = path.join(isolatedAgentDirectory, "to");
  mkdirSync(fromCwd);
  mkdirSync(toCwd);
  const sourceDir = defaultSessionDirForCwd(fromCwd);
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "2026-01-01T00-00-00-000Z_relocate-test.jsonl");
  writeFileSync(
    sourcePath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "relocate-test",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: fromCwd,
    })}\n`,
  );

  const destPath = relocateSessionFile(sourcePath, fromCwd, toCwd);
  assert.equal(path.dirname(destPath), defaultSessionDirForCwd(toCwd));
  const lines = readFileSync(destPath, "utf8").trim().split("\n");
  assert.equal(JSON.parse(lines[0]).cwd, toCwd);
  const notice = JSON.parse(lines[1]);
  assert.equal(notice.type, "custom_message");
  assert.equal(notice.customType, "desktop.cwdChanged");
  assert.match(notice.content, /→/);
});
