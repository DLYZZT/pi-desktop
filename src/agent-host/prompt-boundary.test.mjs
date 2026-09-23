import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { SessionEphemeralContext, createEphemeralContextExtension } from "./session-ephemeral-context.ts";
import { installManagedProcessSessionRedaction } from "./managed-process/session-redaction.ts";
import { setAgentSessionSource } from "./session-source.ts";

const { AgentSessionWrapper } = await importTestBundle("pi-prompt-boundary", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "rpc-manager.ts")],
});

test("Desktop settles once after extension continuation, provider retry, and an IM turn", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let continued = false;
  let failNextRequest = false;
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({
      defaultTools: [],
      cacheWarming: "off",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
    }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "boundary-fixture",
          factory(pi) {
            pi.on("agent_before_settle", () => {
              if (continued) return;
              continued = true;
              return {
                entries: [
                  { type: "custom_message", customType: "test-continuation", content: "continue", display: false },
                ],
                continue: true,
              };
            });
          },
        },
      ],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(directory),
    model,
    tools: [],
  });
  let requests = 0;
  session.agent.streamFunction = (requestModel) => {
    requests++;
    const failed = failNextRequest;
    failNextRequest = false;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: failed ? [] : [{ type: "text", text: "response-" + requests }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: failed ? "error" : "stop",
      ...(failed ? { errorMessage: "429 rate limit fixture" } : {}),
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
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session, [], () => undefined);
  t.after(() => wrapper.dispose());
  const events = [];
  wrapper.start();
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("prompt_done not received")), 3000);
    wrapper.onEvent((event) => {
      if (
        ![
          "agent_start",
          "agent_end",
          "agent_settled",
          "prompt_done",
          "channel_turn_end",
          "auto_retry_start",
          "auto_retry_end",
        ].includes(event.type)
      )
        return;
      events.push(event);
      if (event.type === "prompt_done") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await wrapper.send({ type: "prompt", message: "start", clientRunId: 17 });
  await completed;
  assert.equal(requests, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "agent_end", "agent_start", "agent_end", "agent_settled", "prompt_done"],
  );
  assert.equal(events.at(-1).clientRunId, 17);

  continued = false;
  const external = await wrapper.runExternalTurn({
    runId: "im-boundary",
    channel: "telegram",
    message: "continue from an IM channel",
  });
  assert.equal(requests, 4);
  assert.equal(external.finalText, "response-4");
  assert.deepEqual(
    events.slice(6).map((event) => event.type),
    ["agent_start", "agent_end", "agent_start", "agent_end", "agent_settled", "channel_turn_end"],
  );
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(events.filter((event) => event.type === "channel_turn_end").length, 1);

  continued = true;
  failNextRequest = true;
  const retryStart = events.length;
  const retryCompleted = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("retry prompt_done not received")), 3000);
    wrapper.onEvent((event) => {
      if (event.type === "prompt_done" && event.clientRunId === 18) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await wrapper.send({ type: "prompt", message: "retry after rate limit", clientRunId: 18 });
  await retryCompleted;
  assert.equal(requests, 6);
  const retryEvents = events.slice(retryStart);
  assert.equal(retryEvents.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(
    retryEvents.some((event) => event.type === "auto_retry_start"),
    true,
  );
  assert.equal(
    retryEvents.some((event) => event.type === "auto_retry_end"),
    true,
  );
  assert.equal(
    retryEvents.some((event) => event.type === "agent_end" && event.willRetry === true),
    true,
  );
  assert.equal(retryEvents.at(-1).type, "prompt_done");
  assert.equal(session.getLastAssistantText(), "response-6");
  assert.equal(
    session.sessionManager.getEntries().some((entry) => entry.type === "context_edit"),
    true,
  );
});

test("steering and follow-up queued during a tool run settle as one Desktop prompt", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-queue-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let releaseTool;
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  let signalToolStarted;
  const toolStarted = new Promise((resolve) => {
    signalToolStarted = resolve;
  });
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    tools: ["slow_tool"],
    customTools: [
      {
        name: "slow_tool",
        label: "Slow tool",
        description: "Hold the first run while steering and follow-up are queued",
        parameters: Type.Object({}),
        execute: async () => {
          signalToolStarted();
          await toolGate;
          return { content: [{ type: "text", text: "ready" }] };
        },
      },
    ],
  });
  await session.bindExtensions({ mode: "rpc" });
  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(structuredClone(context));
    const toolCall = requests.length === 1;
    const message = {
      role: "assistant",
      content: toolCall
        ? [{ type: "toolCall", id: "slow-call", name: "slow_tool", arguments: {} }]
        : [{ type: "text", text: `response-${requests.length}` }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: toolCall ? "toolUse" : "stop",
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
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  const liveContextScope = {
    begins: 0,
    beginLocalTurn() {
      this.begins++;
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(session, undefined, () => undefined, undefined, liveContextScope);
  t.after(() => {
    releaseTool();
    void wrapper.dispose();
  });
  wrapper.start();
  const events = [];
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("queued prompt did not settle")), 3000);
    wrapper.onEvent((event) => {
      events.push(event);
      if (event.type === "prompt_done" && event.clientRunId === 44) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await wrapper.send({ type: "prompt", message: "start", clientRunId: 44 });
  await toolStarted;
  await wrapper.send({ type: "prompt", message: "steer this run", streamingBehavior: "steer" });
  await wrapper.send({ type: "prompt", message: "follow up afterwards", streamingBehavior: "followUp" });
  assert.equal(
    events.some((event) => event.type === "prompt_done"),
    false,
  );
  releaseTool();
  await completed;

  const userMessages = manager.getEntries().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "user"
      ? [
          typeof entry.message.content === "string"
            ? entry.message.content
            : entry.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
        ]
      : [],
  );
  assert.deepEqual(userMessages, ["start", "steer this run", "follow up afterwards"]);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 0);
  assert.equal(liveContextScope.begins, 1, "queued messages must not begin another sensitive-result scope");
  assert.equal(
    requests.some((request) => JSON.stringify(request.messages).includes("steer this run")),
    true,
  );
  assert.equal(
    requests.some((request) => JSON.stringify(request.messages).includes("follow up afterwards")),
    true,
  );
});

test("Desktop abort prevents a delayed sensitive tool result from reviving in the next prompt", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-abort-context-"));
  const manager = SessionManager.create(directory, directory);
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  const ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  let releaseTool;
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  let signalToolStarted;
  const toolStarted = new Promise((resolve) => {
    signalToolStarted = resolve;
  });
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createEphemeralContextExtension(ephemeral)],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    tools: ["process_list"],
    customTools: [
      {
        name: "process_list",
        label: "Delayed process result",
        description: "Return after cancellation to exercise late result handling",
        parameters: Type.Object({}),
        execute: async () => {
          signalToolStarted();
          await toolGate;
          return { content: [{ type: "text", text: "LATE_PROCESS_RESULT_42" }] };
        },
      },
    ],
  });
  await session.bindExtensions({ mode: "rpc" });
  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(structuredClone(context));
    const first = requests.length === 1;
    const message = {
      role: "assistant",
      content: first
        ? [{ type: "toolCall", id: "delayed-process", name: "process_list", arguments: {} }]
        : [{ type: "text", text: "safe continuation" }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      stopReason: first ? "toolUse" : "stop",
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
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session, undefined, () => undefined, undefined, ephemeral);
  t.after(async () => {
    releaseTool();
    await wrapper.dispose();
    ephemeral.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  wrapper.start();
  const waitForDone = (runId) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`prompt ${runId} did not finish`)), 3000);
      const unsubscribe = wrapper.onEvent((event) => {
        if (event.type !== "prompt_done" || event.clientRunId !== runId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });

  const abortedDone = waitForDone(70);
  await wrapper.send({ type: "prompt", message: "Start the delayed tool", clientRunId: 70 });
  await toolStarted;
  const aborting = wrapper.send({ type: "abort" });
  await Promise.resolve();
  assert.equal(ephemeral.shouldStopCacheWarming(), true);
  releaseTool();
  await aborting;
  await abortedDone;
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8").includes("LATE_PROCESS_RESULT_42"), false);

  const nextDone = waitForDone(71);
  await wrapper.send({ type: "prompt", message: "Continue after cancellation", clientRunId: 71 });
  await nextDone;
  assert.equal(requests.length >= 2, true);
  assert.equal(JSON.stringify(requests.slice(1)).includes("LATE_PROCESS_RESULT_42"), false);
});
