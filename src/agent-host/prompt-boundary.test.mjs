import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createDeferred } from "#test-timing";
import { Type } from "typebox";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";

const { AgentSessionWrapper, SessionToolPolicy, setAgentSessionSource, getAgentSessionSource } = await importTestBundle(
  "pi-prompt-boundary",
  {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents:
        'export {AgentSessionWrapper} from "./rpc-manager.ts"; export {SessionToolPolicy} from "./session-tool-policy.ts"; export {setAgentSessionSource,getAgentSessionSource} from "./session-source.ts";',
    },
  },
);
const { createLegacyChannelContextExtension } = await importTestBundle("pi-channel-context", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "legacy-channel-context.ts")],
});

for (const handled of [true, false])
  test(`an extension run keeps channel permissions until idle when prompt is ${handled ? "handled" : "rejected"}`, async (t) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-channel-owned-run-")),
      manager = SessionManager.inMemory(cwd);
    const policy = new SessionToolPolicy(manager, ["codemode"], undefined, []);
    const entered = createDeferred(),
      release = createDeferred(),
      localEntered = createDeferred(),
      releaseLocal = createDeferred();
    const services = await createAgentSessionServices({
      cwd,
      agentDir: cwd,
      settingsManager: SettingsManager.inMemory({
        defaultTools: ["codemode"],
        cacheWarming: "off",
        compaction: { enabled: false },
      }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
          policy.extension(),
          {
            name: "interceptor",
            factory(pi) {
              pi.on("input", () => {
                pi.sendMessage({ customType: "owned", content: "continue", display: false }, { triggerTurn: true });
                if (handled) return { action: "handled" };
              });
            },
          },
        ],
      },
    });
    await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture");
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
      tools: ["codemode"],
    });
    policy.bind(session);
    await session.bindExtensions({ mode: "rpc" });
    const wrapper = new AgentSessionWrapper(session, ["codemode"], () => {}, undefined, undefined, policy);
    wrapper.start();
    t.after(async () => {
      releaseLocal.resolve();
      release.resolve();
      await wrapper.dispose({ abort: true });
      rmSync(cwd, { recursive: true, force: true });
    });
    let calls = 0,
      finished = false;
    session.agent.streamFunction = async (model) => {
      if (++calls === 1) {
        localEntered.resolve();
        await releaseLocal.promise;
        return completedStream(model, [{ type: "text", text: "local reply" }]);
      }
      if (calls === 2) {
        entered.resolve();
        await release.promise;
        return completedStream(model, [
          { type: "toolCall", id: "restricted", name: "codemode", arguments: { code: 'text("UNAUTHORIZED")' } },
        ]);
      }
      return completedStream(model, [{ type: "text", text: "fresh reply" }]);
    };
    setAgentSessionSource(manager, "local");
    const localRun = session.sendCustomMessage(
      { customType: "local", content: "local background run", display: false },
      { triggerTurn: true },
    );
    await localEntered.promise;
    const pending = wrapper.runExternalTurn({ runId: "owned", channel: "telegram", message: "intercept me" }).then(
      (result) => {
        finished = true;
        return { result };
      },
      (error) => {
        finished = true;
        return { error };
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(getAgentSessionSource(manager), "local", "a channel must wait before taking over a local run");
    releaseLocal.resolve();
    await localRun;
    await entered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "the outer channel turn must not finish while its extension run is active");
    assert.equal(getAgentSessionSource(manager), "channel");
    assert.equal(policy.isAllowed("codemode"), false);
    release.resolve();
    const outcome = await pending;
    if (handled) assert.equal(outcome.result.finalText, "fresh reply");
    else assert.match(outcome.error.message, /already processing/);
    assert.equal(
      session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "restricted").isError,
      true,
    );
    assert.equal(getAgentSessionSource(manager), "local");
  });

test("channel attachment context belongs to its turn across handled and failed prompt preparation", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-120-channel-boundary-"));
  let sessionForHook;
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({
      defaultTools: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        createLegacyChannelContextExtension(),
        {
          name: "handle-fixture",
          factory(pi) {
            pi.on("input", async (event) => {
              if (event.text === "handled") return { action: "handled" };
              if (event.text === "handled-with-reply") {
                await sessionForHook.sendCustomMessage(
                  { customType: "reply-fixture", content: "Fresh response", display: false },
                  { triggerTurn: true },
                );
                return { action: "handled" };
              }
            });
          },
        },
      ],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    tools: [],
  });
  const wrapper = new AgentSessionWrapper(session, [], () => {});
  sessionForHook = session;
  wrapper.start();
  t.after(async () => {
    await wrapper.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc" });
  const requests = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(context.messages);
    return completedStream(model);
  };
  const previous = await wrapper.runExternalTurn({ runId: "previous", channel: "telegram", message: "previous" });
  assert.equal(previous.finalText, "done");
  const handled = await wrapper.runExternalTurn({
    runId: "handled",
    channel: "telegram",
    message: "handled",
    attachmentContext: "HANDLED_ATTACHMENT",
  });
  assert.equal(handled.finalText, "", "a handled input must not resend the preceding reply");
  const hasAuth = t.mock.method(services.modelRuntime, "hasConfiguredAuth", () => false);
  const checkAuth = t.mock.method(services.modelRuntime, "checkAuth", async () => undefined);
  await assert.rejects(
    wrapper.runExternalTurn({
      runId: "failed",
      channel: "telegram",
      message: "fail",
      attachmentContext: "FAILED_ATTACHMENT",
    }),
  );
  hasAuth.mock.restore();
  checkAuth.mock.restore();
  await wrapper.runExternalTurn({
    runId: "good",
    channel: "telegram",
    message: "read this",
    attachmentContext: "GOOD_ATTACHMENT",
  });
  assert.equal(requests.length, 2);
  const request = JSON.stringify(requests[1]);
  assert.ok(request.includes("GOOD_ATTACHMENT"));
  assert.ok(!request.includes("HANDLED_ATTACHMENT"));
  assert.ok(!request.includes("FAILED_ATTACHMENT"));
  assert.equal(request.split("GOOD_ATTACHMENT").length - 1, 1);
  assert.ok(
    JSON.stringify(session.sessionManager.buildSessionContext().messages).includes("HANDLED_ATTACHMENT"),
    "documented CLI boundary: discarded nextTurn context can remain in the raw SDK transcript",
  );
  const fresh = await wrapper.runExternalTurn({ runId: "fresh", channel: "telegram", message: "handled-with-reply" });
  assert.equal(fresh.finalText, "done", "a new response is retained even when its text equals the preceding reply");
  assert.equal(requests.length, 3);
});

function completedStream(model, content = [{ type: "text", text: "done" }], aborted = false) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
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
  globalThis.queueMicrotask(() => {
    stream.push(
      aborted
        ? { type: "error", reason: "aborted", error: message }
        : { type: "done", reason: message.stopReason, message },
    );
    stream.end();
  });
  return stream;
}

test("1.2.0 custom runs preserve hook prompts after tools and abort during startup sends no model request", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-120-startup-"));
  let hold = false;
  const entered = createDeferred(),
    release = createDeferred(),
    types = [];
  const services = await createAgentSessionServices({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "startup-fixture",
          factory(pi) {
            pi.on("before_agent_start", async (event, ctx) => {
              types.push(event.messageType);
              assert.equal(ctx.isIdle(), false);
              if (hold) {
                entered.resolve();
                await release.promise;
              }
              return { systemPrompt: event.systemPrompt + "\nM1_STABLE_PROMPT" };
            });
          },
        },
      ],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
    customTools: [
      {
        name: "noop",
        label: "noop",
        description: "noop",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });
  t.after(() => {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc" });
  const prompts = [];
  let abortedRequests = 0;
  session.agent.streamFunction = (model, context, options) => {
    if (options.signal?.aborted) {
      abortedRequests++;
      return completedStream(model, [], true);
    }
    prompts.push(getCurrentSystemPrompt(context.messages));
    return completedStream(
      model,
      prompts.length === 1 ? [{ type: "toolCall", id: "noop", name: "noop", arguments: {} }] : undefined,
    );
  };
  await session.sendCustomMessage(
    { customType: "fixture", content: "start custom", display: false },
    { triggerTurn: true },
  );
  assert.deepEqual(types, ["custom"]);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => prompt.includes("M1_STABLE_PROMPT")));
  hold = true;
  const pending = session.prompt("cancel while starting");
  await entered.promise;
  const aborting = session.abort();
  release.resolve();
  await Promise.all([pending, aborting]);
  assert.equal(prompts.length, 2);
  assert.equal(abortedRequests, 1);
  assert.deepEqual(types, ["custom", "user"]);
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
  const wrapper = new AgentSessionWrapper(session, undefined, () => undefined, undefined);
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
  assert.equal(
    requests.some((request) => JSON.stringify(request.messages).includes("steer this run")),
    true,
  );
  assert.equal(
    requests.some((request) => JSON.stringify(request.messages).includes("follow up afterwards")),
    true,
  );
});

test("Desktop abort settles once while preserving a tool's completed late result in canonical history", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-abort-context-"));
  const manager = SessionManager.create(directory, directory);
  setAgentSessionSource(manager, "local");
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
      extensionFactories: [],
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
  const wrapper = new AgentSessionWrapper(session, undefined, () => undefined, undefined);
  t.after(async () => {
    releaseTool();
    await wrapper.dispose();
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
        resolve(event);
      });
    });

  const abortedDone = waitForDone(70);
  await wrapper.send({ type: "prompt", message: "Start the delayed tool", clientRunId: 70 });
  await Promise.race([
    toolStarted,
    abortedDone.then((event) => {
      throw new Error(`Delayed fixture tool did not start: ${JSON.stringify(event)}`);
    }),
  ]);
  const aborting = wrapper.send({ type: "abort" });
  await Promise.resolve();
  releaseTool();
  await aborting;
  await abortedDone;
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  assert.equal(readFileSync(sessionFile, "utf8").includes("LATE_PROCESS_RESULT_42"), true);

  const nextDone = waitForDone(71);
  await wrapper.send({ type: "prompt", message: "Continue after cancellation", clientRunId: 71 });
  await nextDone;
  assert.equal(requests.length >= 2, true);
  assert.equal(JSON.stringify(requests.slice(1)).includes("LATE_PROCESS_RESULT_42"), true);
});
