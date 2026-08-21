import assert from "node:assert/strict";
import test from "node:test";
import { installManagedProcessSessionRedaction, redactManagedProcessPersistedMessage } from "./session-redaction.ts";

test("managed process command, stdin and output are omitted from persisted messages", () => {
  const assistant = redactManagedProcessPersistedMessage({
    role: "assistant",
    content: [
      { type: "text", text: "starting" },
      {
        type: "toolCall",
        id: "call-a",
        name: "process_start",
        arguments: { command: "SECRET_COMMAND", cwd: "/secret/path", label: "frontend" },
      },
      {
        type: "toolCall",
        id: "call-b",
        name: "process_write",
        arguments: { processId: "proc-a", runId: "run-a", text: "SECRET_STDIN" },
      },
    ],
  });
  const serializedAssistant = JSON.stringify(assistant);
  assert.equal(serializedAssistant.includes("SECRET_COMMAND"), false);
  assert.equal(serializedAssistant.includes("/secret/path"), false);
  assert.equal(serializedAssistant.includes("SECRET_STDIN"), false);
  assert.equal(serializedAssistant.includes("frontend"), true);

  const result = redactManagedProcessPersistedMessage({
    role: "toolResult",
    toolName: "process_read",
    content: [{ type: "text", text: "SECRET_OUTPUT" }],
    details: { raw: "SECRET_DETAIL" },
  });
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes("SECRET_OUTPUT"), false);
  assert.equal(serializedResult.includes("SECRET_DETAIL"), false);
  assert.match(serializedResult, /omitted from disk history/);
});

test("session redaction changes only the persisted copy", () => {
  const persisted = [];
  const manager = {
    appendMessage(message) {
      persisted.push(message);
      return "entry-a";
    },
  };
  installManagedProcessSessionRedaction(manager);
  installManagedProcessSessionRedaction(manager);
  const inMemory = {
    role: "toolResult",
    toolName: "process_wait",
    content: [{ type: "text", text: "LIVE_OUTPUT" }],
  };
  manager.appendMessage(inMemory);
  assert.equal(inMemory.content[0].text, "LIVE_OUTPUT");
  assert.equal(JSON.stringify(persisted).includes("LIVE_OUTPUT"), false);
  assert.equal(persisted.length, 1);
});

test("unrelated tool messages are preserved by identity", () => {
  const message = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file" }] };
  assert.equal(redactManagedProcessPersistedMessage(message), message);
});
