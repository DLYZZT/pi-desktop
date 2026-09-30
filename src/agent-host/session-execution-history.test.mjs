import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

const { SessionExecutionHistory, setAgentSessionSource } = await importTestBundle("session-execution-history", {
  packages: "external",
  stdin: {
    contents:
      'export {SessionExecutionHistory} from "./session-execution-history.ts"; export {setAgentSessionSource} from "./session-source.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});
function assistant(model, content, stopReason) {
  const stream = createAssistantMessageEventStream(),
    message = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason,
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  void Promise.resolve().then(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}
async function fixture(
  t,
  failParent = false,
  invalidJournal = false,
  input = { text: "PRIVATE_ORIGINAL" },
  childCount = 1,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-durable-tools-")),
    manager = SessionManager.create(dir, path.join(dir, "sessions"));
  setAgentSessionSource(manager, "local");
  const history = new SessionExecutionHistory(manager, path.join(dir, "desktop"));
  await history.recover();
  if (invalidJournal)
    mkdirSync(path.join(dir, "desktop/tool-executions", manager.getSessionId() + ".jsonl"), { recursive: true });
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [history.extension()],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-execution-history-fixture");
  let childExecutions = 0;
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
    customTools: [
      history.tool(),
      {
        name: "child",
        label: "Child",
        description: "Child fixture",
        parameters: Type.Object({ text: Type.String() }),
        exposure: "deferred",
        async execute(_id, params, _signal, _update, ctx) {
          childExecutions++;
          if (childCount > 1) await ctx.executeTool("leaf", params);
          return {
            content: [{ type: "text", text: "ORIGINAL_CHILD_RESULT_" + params.text }],
            structuredContent: { output: "STRUCTURED_ORIGINAL_" + params.text },
            details: { processId: "fixture-process", runId: "fixture-run" },
          };
        },
      },
      {
        name: "leaf",
        label: "Leaf",
        description: "Third-level fixture",
        parameters: Type.Object({ text: Type.String() }),
        exposure: "deferred",
        async execute(_id, params) {
          return { content: [{ type: "text", text: "ORIGINAL_LEAF_" + params.text }] };
        },
      },
      {
        name: "caller",
        label: "Caller",
        description: "Parent fixture",
        parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params, _signal, _update, ctx) {
          const children = await Promise.all(
            Array.from({ length: childCount }, () => ctx.executeTool("child", params)),
          );
          const child = children[0];
          if (failParent) throw new Error("parent failed after child completed");
          return child.result;
        },
      },
    ],
  });
  let calls = 0;
  const requests = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(context);
    return ++calls === 1
      ? assistant(model, [{ type: "toolCall", id: "parent-call", name: "caller", arguments: input }], "toolUse")
      : assistant(model, [{ type: "text", text: "done" }], "stop");
  };
  await session.bindExtensions({ mode: "rpc" });
  t.after(() => {
    session.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    session,
    manager,
    history,
    requests,
    get executed() {
      return childExecutions;
    },
  };
}

test("SDK nested results and original canonical history survive reopening without an in-memory restore layer", async (t) => {
  const f = await fixture(t);
  await f.session.prompt("Use the fixture", { source: "rpc" });
  assert.equal(f.executed, 1);
  assert.match(readFileSync(f.manager.getSessionFile(), "utf8"), /PRIVATE_ORIGINAL/);
  assert.match(JSON.stringify(f.requests[1].messages), /ORIGINAL_CHILD_RESULT_PRIVATE_ORIGINAL/);
  const history = new SessionExecutionHistory(f.manager, path.join(f.dir, "desktop"));
  const page = await history.query({ includeContent: true });
  const child = page.records.find((record) => record.toolName === "child"),
    parent = page.records.find((record) => record.toolName === "caller");
  assert.equal(child.parentToolCallId, "parent-call");
  assert.equal(child.rootToolCallId, "parent-call");
  assert.equal(child.status, "succeeded");
  assert.equal(parent.status, "succeeded");
  assert.equal(child.arguments.value.text, "PRIVATE_ORIGINAL");
  assert.equal(child.result.value.structuredContent.output, "STRUCTURED_ORIGINAL_PRIVATE_ORIGINAL");
  assert.equal(child.resourceRefs.processId, "fixture-process");
  const tool = history.tool();
  const result = await tool.execute("lookup", { executionId: child.executionId, includeContent: true });
  assert.match(result.content[0].text, /STRUCTURED_ORIGINAL_PRIVATE_ORIGINAL/);
  assert.equal(f.executed, 1, "Reading history must not execute the old operation again");
  const event = { type: "tool_execution_end", toolCallId: child.toolCallId, result: child.result.value };
  const projected = history.projectEvent(event);
  assert.equal(projected.result.structuredContent, undefined);
  assert.ok(event.result.structuredContent);
});

test("a parent failure preserves the independently successful nested execution", async (t) => {
  const f = await fixture(t, true);
  await f.session.prompt("Use the fixture", { source: "rpc" });
  const page = await f.history.query();
  assert.equal(page.records.find((record) => record.toolName === "child").status, "succeeded");
  assert.equal(page.records.find((record) => record.toolName === "caller").status, "failed");
});

test("an execution journal write failure blocks effects at the awaited tool_call hook", async (t) => {
  const f = await fixture(t, false, true);
  await f.session.prompt("Use the fixture", { source: "rpc" });
  assert.equal(f.executed, 0);
  const result = f.manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.equal(result.message.isError, true);
  assert.match(JSON.stringify(result), /EXECUTION_HISTORY_UNAVAILABLE/);
});

test("a reopened and compacted SDK session discovers original child results through the model history tool", async (t) => {
  const f = await fixture(t);
  await f.session.prompt("Complete the fixture", { source: "rpc" });
  const child = (await f.history.query()).records.find((record) => record.toolName === "child");
  const last = f.manager.getBranch().at(-1);
  f.manager.appendCompaction(`Child completed; execution ${child.executionId}`, last.id, 100);
  f.session.dispose();
  const manager = SessionManager.open(f.manager.getSessionFile());
  setAgentSessionSource(manager, "local");
  const history = new SessionExecutionHistory(manager, path.join(f.dir, "desktop"));
  await history.recover();
  const services = await createAgentSessionServices({
    cwd: f.dir,
    agentDir: f.dir,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [history.extension()],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-reopen-fixture");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
    customTools: [history.tool()],
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  const requests = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(context);
    return requests.length === 1
      ? assistant(
          model,
          [
            {
              type: "toolCall",
              id: "read-history",
              name: "tool_history_get",
              arguments: { executionId: child.executionId, includeContent: true },
            },
          ],
          "toolUse",
        )
      : assistant(model, [{ type: "text", text: "Recovered original result" }], "stop");
  };
  await session.prompt("Recover the previous output without executing it again", { source: "rpc" });
  assert.ok(session.getActiveToolNames().includes("tool_history_get"));
  assert.match(JSON.stringify(requests[1].messages), /STRUCTURED_ORIGINAL_PRIVATE_ORIGINAL/);
  assert.equal(f.executed, 1);
  const lookup = JSON.parse((await history.tool().execute("summary", {})).content[0].text);
  assert.equal(
    lookup.records.some((record) => record.toolName === "tool_history_get"),
    false,
  );
  await assert.rejects(history.query({ limit: NaN }), /Invalid execution query/);
});

test("three-level concurrent tools retain original payloads beyond upstream nested-summary limits", async (t) => {
  const marker = "RAW_BEYOND_SUMMARY_" + "x".repeat(12 * 1024);
  const f = await fixture(t, false, false, { text: marker }, 130);
  await f.session.prompt("Run the concurrent fixture", { source: "rpc" });
  assert.equal(f.executed, 130);
  const first = await f.history.query({ limit: 200 });
  const second = await f.history.query({ limit: 200, beforeSequence: first.nextBeforeSequence });
  const records = [...first.records, ...second.records];
  assert.equal(records.length, 261);
  const leaf = records.find((record) => record.toolName === "leaf");
  const parent = records.find((record) => record.toolCallId === leaf.parentToolCallId);
  assert.equal(parent.toolName, "child");
  assert.equal(leaf.rootToolCallId, "parent-call");
  const original = (await f.history.query({ executionId: leaf.executionId, includeContent: true })).records[0];
  assert.equal(original.arguments.value.text, marker);
  assert.equal(original.result.value.content[0].text, "ORIGINAL_LEAF_" + marker);
});

test("invalid input is preserved as a failed attempt without executing the target", async (t) => {
  const f = await fixture(t, false, false, { extra: "ORIGINAL_INVALID_INPUT" });
  await f.session.prompt("Invalid fixture input", { source: "rpc" });
  assert.equal(f.executed, 0);
  const attempt = (await f.history.query({ includeContent: true })).records[0];
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.arguments.value.extra, "ORIGINAL_INVALID_INPUT");
});
