import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSensitiveLeaks, listFilesRecursively } from "../../../scripts/herdr-e2e-safety.mjs";

test("Desktop E2E sensitive scanning includes userData, Pi JSONL, and files beyond 2 MiB", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-e2e-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "user-data");
  const sessionDir = path.join(root, "pi-sessions");
  mkdirSync(userData);
  mkdirSync(sessionDir);
  writeFileSync(path.join(userData, "safe.json"), '{"status":"ready"}');
  writeFileSync(path.join(sessionDir, "session.jsonl"), `${"x".repeat(2 * 1024 * 1024)}PI_HERDR_AGENT_PROMPT_OK`);

  assert.deepEqual(
    listFilesRecursively(userData).map((file) => path.basename(file)),
    ["safe.json"],
  );
  const leaks = await findSensitiveLeaks(
    [userData, sessionDir],
    [{ label: "agent prompt marker", value: "PI_HERDR_AGENT_PROMPT_OK" }],
  );
  assert.deepEqual(
    leaks.map(({ file, label }) => ({ file: path.basename(file), label })),
    [{ file: "session.jsonl", label: "agent prompt marker" }],
  );
});
