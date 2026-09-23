import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { setAgentSessionSource } from "./session-source.ts";
import { installManagedProcessSessionRedaction } from "./managed-process/session-redaction.ts";
import { installHerdrSessionRedaction } from "./herdr/session-redaction.ts";
import { createEphemeralContextExtension, SessionEphemeralContext } from "./session-ephemeral-context.ts";

const SENTINEL = "LIVE_TOOL_RESULT_42";

async function createFixture(
  t,
  toolName,
  toolArguments = {},
  persisted = false,
  otherExtensions = [],
  toolCallIds = ["fixture-call"],
  settingsOverrides = {},
  modelOverrides = {},
  usageInputForRequest = () => 1,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-ephemeral-"));
  const manager = persisted ? SessionManager.create(directory, directory) : SessionManager.inMemory(directory);
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  installHerdrSessionRedaction(manager);
  const ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", ...settingsOverrides }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [...otherExtensions, createEphemeralContextExtension(ephemeral)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: { ...model, ...modelOverrides },
    tools: [toolName],
    customTools: [
      {
        name: toolName,
        label: toolName,
        description: "Offline tool-result projection fixture",
        parameters: Type.Object(toolName === "process_start" ? { command: Type.String() } : {}),
        execute: async () => ({ content: [{ type: "text", text: SENTINEL }], details: { source: "fixture" } }),
      },
    ],
  });
  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    const useTool = requests.length === 1;
    const inputTokens = usageInputForRequest(requests.length);
    const message = {
      role: "assistant",
      content: useTool
        ? toolCallIds.map((id) => ({ type: "toolCall", id, name: toolName, arguments: toolArguments }))
        : [{ type: "text", text: "done" }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: useTool ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: inputTokens,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: inputTokens + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  t.after(() => {
    session.dispose();
    ephemeral.clear();
    rmSync(directory, { recursive: true, force: true });
  });
  return { session, manager, ephemeral, requests };
}

test("persisted JSONL contains only redacted process and Herdr tool output", async (t) => {
  for (const toolName of ["process_list", "herdr_status"]) {
    const { session, manager, requests } = await createFixture(t, toolName, {}, true);
    await session.prompt("Run the fixture tool", { source: "rpc" });
    assert.match(JSON.stringify(requests[1].messages), /LIVE_TOOL_RESULT_42/);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const jsonl = readFileSync(sessionFile, "utf8");
    assert.equal(jsonl.includes(SENTINEL), false);
    assert.match(jsonl, /Sensitive (managed process|Herdr) result was not saved/);
  }
});

test("an oversized live result fails before any sensitive bytes are persisted", () => {
  const manager = SessionManager.inMemory();
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  const ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  const content = "S".repeat(16 * 1024 * 1024);
  assert.throws(
    () =>
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "large-fixture",
        toolName: "process_read",
        content: [{ type: "text", text: content }],
        isError: false,
        timestamp: Date.now(),
      }),
    /live context memory budget/,
  );
  assert.equal(manager.getEntries().length, 0);
  ephemeral.clear();
});

test("the Host-wide live context budget is shared across sessions and released on disposal", () => {
  const contexts = [];
  const content = "S".repeat(13 * 1024 * 1024);
  const createContext = () => {
    const manager = SessionManager.inMemory();
    setAgentSessionSource(manager, "local");
    installManagedProcessSessionRedaction(manager);
    const ephemeral = new SessionEphemeralContext(manager);
    ephemeral.install();
    contexts.push({ manager, ephemeral });
    return manager;
  };
  const append = (manager, id, text) =>
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "process_read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    });

  try {
    for (let index = 0; index < 4; index++) {
      const manager = createContext();
      assert.ok(append(manager, `budget-${index}`, content));
    }
    const rejected = createContext();
    assert.throws(() => append(rejected, "budget-overflow", content), /live context memory budget/);
    assert.equal(rejected.getEntries().length, 0);

    contexts[0].ephemeral.dispose();
    assert.ok(append(rejected, "budget-reused", content));
    assert.equal(JSON.stringify(rejected.getEntries()).includes(content), false);
  } finally {
    for (const { ephemeral } of contexts) ephemeral.dispose();
  }
});

test("a late tool callback after disposal cannot re-register raw context", () => {
  const manager = SessionManager.inMemory();
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  const ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  ephemeral.dispose();
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "late-fixture",
    toolName: "process_list",
    content: [{ type: "text", text: SENTINEL }],
    isError: false,
    timestamp: Date.now(),
  });
  assert.equal(JSON.stringify(manager.getEntries()).includes(SENTINEL), false);
  assert.equal(
    JSON.stringify(ephemeral.transform(manager.buildSessionProjection().messages)).includes(SENTINEL),
    false,
  );
  assert.equal(ephemeral.shouldStopCacheWarming(), true);
});

test("an aborted run discards live records and ignores late callbacks until a new turn", () => {
  const manager = SessionManager.inMemory();
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  const ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  const result = (id) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "process_list",
    content: [{ type: "text", text: SENTINEL }],
    isError: false,
    timestamp: Date.now(),
  });

  manager.appendMessage(result("before-abort"));
  assert.match(JSON.stringify(ephemeral.transform(manager.buildSessionProjection().messages)), /LIVE_TOOL_RESULT_42/);
  ephemeral.suspendAfterAbort();
  manager.appendMessage(result("late-aborted-callback"));
  assert.equal(
    JSON.stringify(ephemeral.transform(manager.buildSessionProjection().messages)).includes(SENTINEL),
    false,
  );
  assert.equal(JSON.stringify(manager.getEntries()).includes(SENTINEL), false);
  assert.equal(ephemeral.shouldStopCacheWarming(), true);

  ephemeral.beginLocalTurn();
  manager.appendMessage(result("new-turn"));
  const resumed = ephemeral.transform(manager.buildSessionProjection().messages);
  assert.equal(resumed.filter((message) => JSON.stringify(message).includes(SENTINEL)).length, 1);
  ephemeral.dispose();
});

for (const toolName of ["process_list", "herdr_status"]) {
  test(toolName + " remains available to the next model request but is never saved raw", async (t) => {
    const { session, manager, requests } = await createFixture(t, toolName);
    await session.prompt("Run the fixture tool", { source: "rpc" });
    assert.equal(requests.length, 2);
    const result = requests[1].messages.find((message) => message.role === "toolResult");
    assert.equal(result.content[0].text, SENTINEL);
    const persisted = JSON.stringify(manager.getEntries());
    assert.equal(persisted.includes(SENTINEL), false);
    assert.match(persisted, /Sensitive (managed process|Herdr) result was not saved/);
  });
}

test("multiple sensitive calls keep their IDs and each live result while storing only placeholders", async (t) => {
  const { session, manager, requests } = await createFixture(
    t,
    "process_list",
    {},
    false,
    [],
    ["fixture-a", "fixture-b"],
  );
  await session.prompt("Run two fixture calls", { source: "rpc" });
  const results = requests[1].messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(results.map((result) => result.toolCallId).sort(), ["fixture-a", "fixture-b"]);
  assert.equal(
    results.every((result) => result.content[0].text === SENTINEL),
    true,
  );
  assert.equal(JSON.stringify(manager.getEntries()).includes(SENTINEL), false);
});

test("mixed ordinary, image, and error results preserve model metadata without leaking sensitive bytes", async (t) => {
  const { session, manager, requests } = await createFixture(t, "process_list", {}, true);
  await session.prompt("Run the first sensitive tool", { source: "rpc" });
  const imageData = "UE5HX0xJVkVfNDI=";
  const errorText = "LIVE_PROCESS_ERROR_42";
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "image-call", name: "process_read", arguments: {} },
      { type: "toolCall", id: "error-call", name: "process_wait", arguments: {} },
      { type: "toolCall", id: "ordinary-call", name: "read", arguments: {} },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "image-call",
    toolName: "process_read",
    content: [{ type: "image", mimeType: "image/png", data: imageData }],
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "error-call",
    toolName: "process_wait",
    content: [{ type: "text", text: errorText }],
    isError: true,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "ordinary-call",
    toolName: "read",
    content: [{ type: "text", text: "PUBLIC_RESULT" }],
    isError: false,
    timestamp: Date.now(),
  });
  await session.prompt("Continue with all results", { source: "rpc" });

  const results = requests.at(-1).messages.filter((message) => message.role === "toolResult");
  const image = results.find((result) => result.toolCallId === "image-call");
  const error = results.find((result) => result.toolCallId === "error-call");
  const ordinary = results.find((result) => result.toolCallId === "ordinary-call");
  assert.deepEqual(image.content, [{ type: "image", mimeType: "image/png", data: imageData }]);
  assert.equal(error.content[0].text, errorText);
  assert.equal(error.isError, true);
  assert.equal(ordinary.content[0].text, "PUBLIC_RESULT");
  const file = manager.getSessionFile();
  assert.ok(file);
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes(imageData), false);
  assert.equal(persisted.includes(errorText), false);
  assert.match(persisted, /PUBLIC_RESULT/);
});

test("sensitive call arguments are restored without undoing persisted argument redaction", async (t) => {
  const command = "SECRET_COMMAND_42";
  const { session, manager, requests } = await createFixture(t, "process_start", { command });
  await session.prompt("Start the fixture process", { source: "rpc" });
  const assistant = requests[1].messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content.find((block) => block.type === "toolCall").arguments.command, command);
  assert.equal(JSON.stringify(manager.getEntries()).includes(command), false);
});

test("context omissions and replacements cannot revive sensitive results", async (t) => {
  const { session, manager, requests } = await createFixture(t, "process_list");
  await session.prompt("Run the fixture tool", { source: "rpc" });
  const resultEntry = manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(resultEntry);
  manager.appendContextEdit(resultEntry.id, null);
  await session.prompt("Continue after omission", { source: "rpc" });
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(SENTINEL), false);
  assert.equal(
    requests.at(-1).messages.some((message) => message.role === "toolResult"),
    false,
  );
});

test("a content replacement wins over a live sensitive result", async (t) => {
  const { session, manager, requests } = await createFixture(t, "process_list");
  await session.prompt("Run the fixture tool", { source: "rpc" });
  const resultEntry = manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(resultEntry);
  manager.appendContextEdit(resultEntry.id, { content: [{ type: "text", text: "REPLACEMENT_SAFE_42" }] });
  await session.prompt("Continue after replacement", { source: "rpc" });
  const context = JSON.stringify(requests.at(-1).messages);
  assert.equal(context.includes(SENTINEL), false);
  assert.match(context, /REPLACEMENT_SAFE_42/);
});

test("a user extension's context replacement is not overwritten by live-result restoration", async (t) => {
  const extension = {
    name: "user-context-edit",
    factory(pi) {
      pi.on("context", (event) => ({
        messages: event.messages.map((message) =>
          message.role === "toolResult"
            ? { ...message, content: [{ type: "text", text: "USER_SELECTED_CONTEXT" }] }
            : message,
        ),
      }));
    },
  };
  const { session, requests } = await createFixture(t, "process_list", {}, false, [extension]);
  await session.prompt("Run the fixture tool", { source: "rpc" });
  const result = requests[1].messages.find((message) => message.role === "toolResult");
  assert.equal(result.content[0].text, "USER_SELECTED_CONTEXT");
  assert.equal(JSON.stringify(requests[1].messages).includes(SENTINEL), false);
});

test("a channel result is live only in its own turn", async (t) => {
  const { session, manager, ephemeral, requests } = await createFixture(t, "process_list");
  setAgentSessionSource(manager, "channel");
  ephemeral.beginChannelTurn("channel-run-1");
  await session.prompt("Run the channel fixture tool", { source: "rpc" });
  assert.match(JSON.stringify(requests[1].messages), /LIVE_TOOL_RESULT_42/);
  const decision = {
    type: "cache_warming_decision",
    action: "warm",
    warmCost: 0,
    missCost: 1,
    continuationProbability: 1,
  };
  assert.equal(await session.extensionRunner.emitCacheWarmingDecision(decision), "warm");
  ephemeral.endChannelTurn();
  assert.equal(await session.extensionRunner.emitCacheWarmingDecision(decision), "stop");
  setAgentSessionSource(manager, "local");
  await session.prompt("Continue locally", { source: "rpc" });
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(SENTINEL), false);
});

test("clearing a live result stops warming a request that still holds the old context", async (t) => {
  const { session, ephemeral } = await createFixture(t, "process_list");
  await session.prompt("Run the fixture tool", { source: "rpc" });
  const decision = {
    type: "cache_warming_decision",
    action: "warm",
    warmCost: 0,
    missCost: 1,
    continuationProbability: 1,
  };
  assert.equal(await session.extensionRunner.emitCacheWarmingDecision(decision), "warm");
  ephemeral.clear();
  assert.equal(await session.extensionRunner.emitCacheWarmingDecision(decision), "stop");
});

test("retain-none compaction removes live result context without writing the result into a summary", async (t) => {
  const { session, manager, requests } = await createFixture(t, "herdr_status");
  await session.prompt("Run the fixture tool", { source: "rpc" });
  manager.appendCompaction("Safe fixture summary", null, 2);
  await session.prompt("Continue after compaction", { source: "rpc" });
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(SENTINEL), false);
  assert.equal(JSON.stringify(manager.getEntries()).includes(SENTINEL), false);
  const compaction = manager.getEntries().find((entry) => entry.type === "compaction");
  assert.ok(compaction);
  assert.equal(compaction.firstKeptEntryId, compaction.id);
});

test("SDK compaction summarizes only redacted canonical history after a live sensitive result", async (t) => {
  const { session, manager, requests } = await createFixture(t, "process_list", {}, true, [], ["fixture-call"], {
    compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 1024 },
  });
  await session.prompt("Run the sensitive tool", { source: "rpc" });
  assert.match(JSON.stringify(requests[1].messages), /LIVE_TOOL_RESULT_42/);
  await session.prompt("Continue with its result", { source: "rpc" });
  const beforeCompaction = requests.length;

  const compacted = await session.compact();
  assert.ok(compacted.summary);
  assert.ok(requests.length > beforeCompaction);
  for (const request of requests.slice(beforeCompaction)) {
    assert.equal(JSON.stringify(request.messages).includes(SENTINEL), false);
  }
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.equal(persisted.includes(SENTINEL), false);
  assert.equal(compacted.summary.includes(SENTINEL), false);

  await session.prompt("Continue after compaction", { source: "rpc" });
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(SENTINEL), false);
});

test("a forked session cannot reconstruct live sensitive context from its copied JSONL", async (t) => {
  const { session, manager, requests } = await createFixture(t, "process_list", {}, true);
  await session.prompt("Run the sensitive tool", { source: "rpc" });
  assert.match(JSON.stringify(requests[1].messages), /LIVE_TOOL_RESULT_42/);
  const resultEntry = manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(resultEntry);
  const forkPath = manager.createBranchedSession(resultEntry.id);
  assert.ok(forkPath);
  assert.equal(readFileSync(forkPath, "utf8").includes(SENTINEL), false);

  const directory = path.dirname(forkPath);
  const forkManager = SessionManager.open(forkPath, directory);
  setAgentSessionSource(forkManager, "local");
  installManagedProcessSessionRedaction(forkManager);
  const forkEphemeral = new SessionEphemeralContext(forkManager);
  forkEphemeral.install();
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createEphemeralContextExtension(forkEphemeral)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session: fork } = await createAgentSessionFromServices({
    services,
    sessionManager: forkManager,
    model,
    tools: [],
  });
  t.after(() => {
    fork.dispose();
    forkEphemeral.dispose();
  });
  const forkRequests = [];
  fork.agent.streamFunction = (requestModel, context) => {
    forkRequests.push(structuredClone(context));
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "fork continued" }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: "stop",
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
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await fork.bindExtensions({ mode: "rpc" });
  await fork.prompt("Continue the fork", { source: "rpc" });
  assert.equal(forkRequests.length, 1);
  assert.equal(JSON.stringify(forkRequests[0].messages).includes(SENTINEL), false);
  assert.match(JSON.stringify(forkRequests[0].messages), /Sensitive managed process result was not saved/);
});

test("automatic SDK compaction uses redacted canonical history before a long continuation", async (t) => {
  const { session, manager, requests } = await createFixture(
    t,
    "process_list",
    {},
    true,
    [],
    ["fixture-call"],
    { compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 32 } },
    { contextWindow: 128 },
    (requestCount) => (requestCount === 3 ? 256 : 1),
  );
  assert.equal(session.model.contextWindow, 128);
  assert.deepEqual(session.settingsManager.getCompactionSettings(session.model), {
    enabled: true,
    reserveTokens: 32,
    keepRecentTokens: 0,
  });
  await session.prompt("Run the sensitive tool", { source: "rpc" });
  assert.match(JSON.stringify(requests[1].messages), /LIVE_TOOL_RESULT_42/);
  await session.prompt("Continue with enough context to trigger compaction. ".repeat(20), { source: "rpc" });
  assert.match(JSON.stringify(requests[2].messages), /LIVE_TOOL_RESULT_42/);

  const compaction = manager.getEntries().find((entry) => entry.type === "compaction");
  assert.ok(compaction);
  assert.ok(requests.length > 3);
  for (const request of requests.slice(3)) {
    assert.equal(JSON.stringify(request.messages).includes(SENTINEL), false);
  }
  assert.equal(compaction.summary.includes(SENTINEL), false);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8").includes(SENTINEL), false);
});
