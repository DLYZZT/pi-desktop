import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installHerdrSessionRedaction, redactHerdrPersistedMessage } from "./session-redaction.ts";

test("Herdr prompts and live tool results are omitted from persisted messages", () => {
  const assistant = redactHerdrPersistedMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-a",
        name: "herdr_agent_prompt",
        arguments: { paneId: "pane-a", prompt: "SECRET_PROMPT" },
      },
    ],
  });
  assert.equal(JSON.stringify(assistant).includes("SECRET_PROMPT"), false);
  assert.equal(JSON.stringify(assistant).includes("pane-a"), true);

  const result = redactHerdrPersistedMessage({
    role: "toolResult",
    toolName: "herdr_pane_read",
    toolCallId: "call-b",
    content: [{ type: "text", text: "SECRET_TERMINAL_OUTPUT" }],
    details: { raw: "SECRET_DETAIL" },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("SECRET_TERMINAL_OUTPUT"), false);
  assert.equal(serialized.includes("SECRET_DETAIL"), false);
  assert.match(serialized, /Sensitive Herdr result was not saved/);

  const failed = redactHerdrPersistedMessage({
    role: "toolResult",
    toolName: "herdr_agent_start",
    toolCallId: "call-error",
    isError: true,
    content: [
      {
        type: "text",
        text: "HERDR_AGENT_BINARY_MISSING: unavailable at /private/secret/bin",
      },
    ],
  });
  assert.deepEqual(failed.details, { errorCode: "HERDR_AGENT_BINARY_MISSING" });
  assert.match(failed.content[0].text, /HERDR_AGENT_BINARY_MISSING/u);
  assert.doesNotMatch(JSON.stringify(failed), /private|secret/u);

  const waitCall = redactHerdrPersistedMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-wait",
        name: "herdr_pane_wait_for_output",
        arguments: { paneId: "pane-a", text: "SECRET_OUTPUT_MARKER" },
      },
    ],
  });
  assert.equal(JSON.stringify(waitCall).includes("SECRET_OUTPUT_MARKER"), false);
  assert.match(JSON.stringify(waitCall), /redacted Herdr pane output match/);
});

test("Herdr session redaction changes only the persisted copy and installs once", () => {
  const persisted = [];
  const manager = {
    appendMessage(message) {
      persisted.push(message);
      return "entry-a";
    },
  };
  installHerdrSessionRedaction(manager);
  installHerdrSessionRedaction(manager);
  const live = {
    role: "toolResult",
    toolName: "herdr_list",
    content: [{ type: "text", text: "LIVE_FLEET" }],
  };
  manager.appendMessage(live);
  assert.equal(live.content[0].text, "LIVE_FLEET");
  assert.equal(JSON.stringify(persisted).includes("LIVE_FLEET"), false);
  assert.equal(persisted.length, 1);
});

test("unrelated messages are preserved by identity", () => {
  const message = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file" }] };
  assert.equal(redactHerdrPersistedMessage(message), message);
});

test("real SessionManager round-trip omits Herdr results and derived compaction text", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-redaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  installHerdrSessionRedaction(manager);
  const firstId = manager.appendMessage({ role: "user", content: "inspect fleet", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-secret",
        name: "herdr_pane_read",
        arguments: { paneId: "pane-a" },
      },
    ],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolName: "herdr_pane_read",
    toolCallId: "call-secret",
    content: [{ type: "text", text: "ROUND_TRIP_SECRET" }],
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendCompaction("SUMMARY_WITH_ROUND_TRIP_SECRET", firstId, 100);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.equal(persisted.includes("ROUND_TRIP_SECRET"), false);
  assert.match(persisted, /compaction summary containing live Herdr context was not saved/);
  const reopened = SessionManager.open(sessionFile, directory);
  assert.equal(JSON.stringify(reopened.getEntries()).includes("ROUND_TRIP_SECRET"), false);
});
