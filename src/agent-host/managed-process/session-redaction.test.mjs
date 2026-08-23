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
  assert.match(serializedResult, /Sensitive managed process result was not saved/);
});

test("managed process errors retain only a safe whitelisted error projection", () => {
  const result = redactManagedProcessPersistedMessage({
    role: "toolResult",
    toolName: "process_start",
    toolCallId: "call-safe",
    isError: true,
    content: [
      {
        type: "text",
        text: "PROCESS_CONTAINMENT_UNAVAILABLE: CreateProcess failed at C:\\secret with command SECRET_COMMAND",
      },
    ],
    details: { win32: 5, path: "C:\\secret" },
    error: "SECRET_COMMAND",
  });
  assert.deepEqual(result, {
    role: "toolResult",
    toolName: "process_start",
    toolCallId: "call-safe",
    isError: true,
    errorCode: "PROCESS_CONTAINMENT_UNAVAILABLE",
    content: [
      {
        type: "text",
        text: "PROCESS_CONTAINMENT_UNAVAILABLE: Managed process request failed. Sensitive details were not saved.",
      },
    ],
  });
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(JSON.stringify(result).includes("C:\\\\secret"), false);
});

test("unrecognized error text is omitted without inventing a process id or refresh action", () => {
  const result = redactManagedProcessPersistedMessage({
    role: "toolResult",
    toolName: "process_start",
    isError: true,
    content: [{ type: "text", text: "PRIVATE_FAILURE" }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_FAILURE"), false);
  assert.equal(serialized.includes("process_read"), false);
  assert.equal(serialized.includes("errorCode"), false);
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
