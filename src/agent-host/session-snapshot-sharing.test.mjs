import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importTestBundle } from "#test-bundle";

const { SessionIndex, getSessionContentSnapshot, reads } = await importTestBundle("session-snapshot-sharing", {
  packages: "external",
  stdin: {
    contents:
      'export { SessionIndex } from "./session-index.ts"; export { getSessionContentSnapshot } from "./session-content-cache.ts"; export { reads } from "./session-readonly.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "count-snapshot-parses",
      setup(build) {
        build.onResolve({ filter: /^\.\/session-readonly\.ts$/ }, () => ({
          path: "reader",
          namespace: "count-reader",
        }));
        build.onLoad({ filter: /.*/, namespace: "count-reader" }, () => ({
          loader: "js",
          resolveDir: import.meta.dirname,
          contents: `
      import { readSessionSnapshot as read } from ${JSON.stringify(path.join(import.meta.dirname, "session-readonly.ts"))};
      export const reads = [];
      export function readSessionSnapshot(file) { reads.push(file); return read(file); }
    `,
        }));
      },
    },
  ],
});

test("index refresh and history read share one bounded snapshot per file version", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-shared-snapshot-"));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  const file = path.join(root, "history.jsonl");
  const header = { type: "session", version: 3, id: "shared", timestamp: "2026-09-27T00:00:00Z", cwd };
  const entry = {
    type: "message",
    id: "first",
    parentId: null,
    timestamp: header.timestamp,
    message: { role: "user", content: "first" },
  };
  writeFileSync(file, JSON.stringify(header) + "\n" + JSON.stringify(entry) + "\n");
  const index = new SessionIndex();
  reads.length = 0;
  await index.refreshPath(file);
  const initial = getSessionContentSnapshot(file);
  assert.equal(reads.length, 1);
  assert.equal(getSessionContentSnapshot(file), initial);
  const added = { ...entry, id: "second", parentId: "first", message: { role: "user", content: "second" } };
  appendFileSync(file, JSON.stringify(added) + "\n");
  const source = readFileSync(file, "utf8");
  await index.refreshPath(file);
  const latest = getSessionContentSnapshot(file);
  assert.equal(reads.length, 2);
  assert.notEqual(latest, initial);
  assert.equal(latest.entries.length, 2);
  assert.equal(readFileSync(file, "utf8"), source);
});
