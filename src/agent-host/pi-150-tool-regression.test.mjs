import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { importTestBundle } from "#test-bundle";

const root = mkdtempSync(path.join(tmpdir(), "pi-150-tools-"));
process.env.PI_DESKTOP_USER_DATA = root;
test.after(() => rmSync(root, { recursive: true, force: true }));
const {
  createHerdrToolDefinitions,
  createBrowserToolDefinitions,
  createManagedProcessToolDefinitions,
  SessionExecutionHistory,
  setAgentSessionSource,
} = await importTestBundle("pi-150-tools", {
  packages: "external",
  stdin: {
    contents: [
      'export {createHerdrToolDefinitions} from "./herdr/tools.ts";',
      'export {createBrowserToolDefinitions} from "./browser-tools.ts";',
      'export {createManagedProcessToolDefinitions} from "./managed-process/tools.ts";',
      'export {SessionExecutionHistory} from "./session-execution-history.ts";',
      'export {setAgentSessionSource} from "./session-source.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

async function run(tool, args, options = {}) {
  const call = { id: "fixture", name: tool.name, type: "toolCall", arguments: args };
  return runToolCall(call, {
    assistantMessage: { role: "assistant", content: [call], timestamp: 0 },
    context: { messages: [], tools: [tool] },
    tools: [tool],
    ...options,
  });
}

test("Pi 1.5 coerces plain and Unsafe schemas without mutating recorded arguments", async () => {
  const cases = [
    [Type.Integer(), 3.9, 3],
    [Type.Integer(), -3.5, -3],
    [Type.Integer({ maximum: 10 }), 10.7, 10],
    [Type.String({ minLength: 1 }), null, "null"],
    [Type.Array(Type.String()), null, ["null"]],
    [Type.Union([Type.Integer(), Type.String()]), 2.5, 2],
    [Type.Union([Type.String(), Type.Integer()]), 2.5, "2.5"],
  ];
  for (const [schema, value, expected] of cases) {
    for (const kind of ["plain", "unsafe", "typebox"]) {
      const native = Type.Object({ value: schema });
      const plain = JSON.parse(JSON.stringify(native));
      const parameters = kind === "typebox" ? native : kind === "unsafe" ? Type.Unsafe(plain) : plain;
      const args = { value };
      const original = structuredClone(args);
      let received;
      const outcome = await run(
        {
          name: "fixture",
          label: "fixture",
          description: "fixture",
          parameters,
          execute: async (_id, input) => {
            received = input;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
        args,
      );
      assert.equal(outcome.isError, false, kind);
      assert.deepEqual(received, { value: expected }, kind);
      assert.deepEqual(args, original, "the transcript retains the original values");
    }
  }
});

test("native Desktop schemas keep existing coercion while errors and revoked access never execute", async () => {
  const manager = SessionManager.inMemory(root);
  setAgentSessionSource(manager, "local");
  const calls = [];
  const bridge = {
    getRuntime: () => ({ status: "ready" }),
    promptAgent: async (...args) => {
      calls.push(["prompt", ...args]);
      return {};
    },
    renameTab: async (...args) => {
      calls.push(["tab", ...args]);
      return {};
    },
    renameWorkspace: async (...args) => {
      calls.push(["workspace", ...args]);
      return {};
    },
  };
  const herdr = createHerdrToolDefinitions(root, bridge);
  const browser = createBrowserToolDefinitions();
  const managed = createManagedProcessToolDefinitions(root, true, {});
  const history = new SessionExecutionHistory(manager, path.join(root, "history"));
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const cases = [
    [
      herdr.find((tool) => tool.name === "herdr_agent_prompt"),
      { paneId: id, prompt: null },
      { paneId: id, prompt: "null" },
      true,
    ],
    [
      herdr.find((tool) => tool.name === "herdr_tab_rename"),
      { tabId: id, name: null },
      { tabId: id, name: "null" },
      true,
    ],
    [
      herdr.find((tool) => tool.name === "herdr_workspace_rename"),
      { workspaceId: id, name: null },
      { workspaceId: id, name: "null" },
      true,
    ],
    [
      browser.find((tool) => tool.name === "browser_scroll"),
      { tabId: id, deltaY: 3.9 },
      { tabId: id, deltaY: 3 },
      false,
    ],
    [
      browser.find((tool) => tool.name === "browser_snapshot"),
      { tabId: id, maxNodes: 2000.7 },
      { tabId: id, maxNodes: 2000 },
      false,
    ],
    [
      managed.find((tool) => tool.name === "process_read"),
      { processId: id, maxBytes: 3.9 },
      { processId: id, maxBytes: 3 },
      false,
    ],
    [history.tool(), { limit: 200.7 }, { limit: 200 }, true],
  ];
  const ctx = { sessionManager: manager, hasUI: false, ui: {} };
  for (const [definition, args, expected, executeReal] of cases) {
    let executions = 0;
    const tool = {
      ...definition,
      execute: async (callId, input, signal, update) => {
        executions++;
        assert.deepEqual(input, expected);
        return executeReal
          ? definition.execute(callId, input, signal, update, ctx)
          : { content: [{ type: "text", text: "fixture" }] };
      },
    };
    assert.equal((await run(tool, args)).isError, false, definition.name);
    assert.equal(executions, 1);
    assert.equal(
      (await run(tool, args, { beforeToolCall: () => ({ block: true, reason: "TOOL_PERMISSION_DENIED" }) })).isError,
      true,
    );
    assert.equal(executions, 1, "revocation prevents effects even for valid converted arguments");
    const malformed = { ...tool, prepareArguments: undefined };
    const outcome = await runToolCall(
      { id: "broken", name: tool.name, type: "toolCall", arguments: {}, argumentsError: "truncated JSON" },
      {
        assistantMessage: { role: "assistant", content: [], timestamp: 0 },
        context: { messages: [], tools: [malformed] },
        tools: [malformed],
      },
    );
    assert.equal(outcome.isError, true);
    assert.equal(executions, 1);
  }
  assert.deepEqual(calls, [
    ["prompt", id, "null"],
    ["tab", id, "null"],
    ["workspace", id, "null"],
  ]);
});
