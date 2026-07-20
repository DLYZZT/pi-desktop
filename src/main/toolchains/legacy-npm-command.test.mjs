import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLegacyNpmCommand, validateLegacyNpmCommand } from "./legacy-npm-command.ts";

test("reads the existing global npmCommand without modifying Pi settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-npm-command-"));
  try {
    const agentDir = path.join(root, "配置", "agent");
    const settingsPath = path.join(agentDir, "settings.json");
    fs.mkdirSync(agentDir, { recursive: true });
    const original = `${JSON.stringify({ npmCommand: ["mise", "exec", "node@22", "--", "npm"], theme: "dark" }, null, 2)}\n`;
    fs.writeFileSync(settingsPath, original, "utf8");

    assert.deepEqual(
      readLegacyNpmCommand({
        homeDir: root,
        env: { PI_CODING_AGENT_DIR: agentDir },
        platform: process.platform,
      }),
      ["mise", "exec", "node@22", "--", "npm"],
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed, oversized, and command-injection-shaped legacy values", () => {
  for (const value of [
    "npm",
    [],
    ["npm\nwhoami"],
    ["npm", ""],
    Array.from({ length: 17 }, () => "x"),
    ["x".repeat(4_097)],
  ]) {
    assert.equal(validateLegacyNpmCommand(value), undefined);
  }
});
