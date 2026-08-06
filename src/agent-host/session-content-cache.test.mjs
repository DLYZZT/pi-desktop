import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `session-content-cache-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "session-content-cache.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { getSessionContentSnapshot, invalidateSessionContent } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

test("content snapshots reuse stable files and invalidate on append or explicit removal", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-session-content-"));
  const filePath = path.join(fixtureRoot, "session.jsonl");
  test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const header = {
    type: "session",
    version: 3,
    id: "content-session",
    timestamp: "2026-08-06T00:00:00.000Z",
    cwd: fixtureRoot,
  };
  const user = {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: "2026-08-06T00:00:01.000Z",
    message: { role: "user", content: "hello", timestamp: Date.parse("2026-08-06T00:00:01.000Z") },
  };
  writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`, "utf8");

  const first = getSessionContentSnapshot(filePath);
  const reused = getSessionContentSnapshot(filePath);
  assert.equal(reused.manager, first.manager);
  assert.equal(reused.entries.length, 1);

  appendFileSync(
    filePath,
    `${JSON.stringify({
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp: "2026-08-06T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "test",
        model: "test",
        timestamp: Date.parse("2026-08-06T00:00:02.000Z"),
      },
    })}\n`,
  );
  const appended = getSessionContentSnapshot(filePath);
  assert.notEqual(appended.manager, first.manager);
  assert.equal(appended.entries.length, 2);

  invalidateSessionContent(filePath);
  const invalidated = getSessionContentSnapshot(filePath);
  assert.notEqual(invalidated.manager, appended.manager);
  assert.equal(invalidated.entries.length, 2);
});
