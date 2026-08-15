import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
const { AgentSessionWrapper, getLegacySessionToolNames } = await importTestBundle(
  "src/agent-host/channels/channel-session-scheduler",
  {
    packages: "external",
    stdin: {
      contents: 'export { AgentSessionWrapper, getLegacySessionToolNames } from "../rpc-manager.ts";',
      resolveDir: import.meta.dirname,
      sourcefile: "channel-session-test-entry.ts",
      loader: "ts",
    },
  },
);

test("UI prompts and messaging-channel turns share one serial session scheduler", async (t) => {
  const order = [];
  let releaseUi;
  const uiGate = new Promise((resolve) => {
    releaseUi = resolve;
  });
  let last = "";
  let externalPromptOptions;
  const customEntries = [];
  const customMessages = [];
  let sessionListener = () => undefined;
  const inner = {
    sessionId: "session-one",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined },
    sessionManager: {
      getHeader: () => ({ cwd: "/tmp/shared-workspace" }),
      appendCustomEntry(customType, data) {
        customEntries.push({ customType, data });
      },
    },
    settingsManager: {},
    agent: {
      state: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "[外部消息来源：微信]\n发送者标识：123\n---\nlegacy text" }],
          },
        ],
      },
    },
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe(listener) {
      sessionListener = listener;
      return () => undefined;
    },
    async prompt(message, options) {
      order.push(`${message}-start`);
      if (message === "ui") await uiGate;
      if (message === "im") {
        externalPromptOptions = options;
        sessionListener({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "im" }] },
        });
        sessionListener({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
        });
      }
      last = `reply:${message}`;
      order.push(`${message}-end`);
    },
    async sendCustomMessage(message, options) {
      customMessages.push({ message, options });
    },
    async compact(instructions) {
      order.push(`compact:${instructions}`);
    },
    getLastAssistantText: () => last,
  };
  const wrapper = new AgentSessionWrapper(inner);
  assert.equal(wrapper.cwd, "/tmp/shared-workspace");
  assert.equal(inner.agent.state.messages[0].content[0].text, "legacy text");
  wrapper.extensionsBound = true;
  wrapper.start();
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "ui" });
  const progress = [];
  const external = wrapper.runExternalTurn({
    runId: "run-one",
    message: "im",
    channel: "telegram",
    images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    channelAttachments: [{ kind: "image", name: "photo.png", mime: "image/png" }],
    attachmentContext: "Attachment 1 is available at /tmp/file.txt",
    onProgress: (event) => progress.push(event),
  });
  const compact = wrapper.runExternalCommand({ command: "compact", customInstructions: "keep decisions" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["ui-start"]);
  releaseUi();
  const result = await external;
  await compact;
  assert.deepEqual(order, ["ui-start", "ui-end", "im-start", "im-end", "compact:keep decisions"]);
  assert.equal(result.finalText, "reply:im");
  assert.deepEqual(externalPromptOptions.images, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  assert.equal(externalPromptOptions.expandPromptTemplates, false);
  assert.deepEqual(customEntries, [
    {
      customType: "pi-desktop-channel-source",
      data: {
        runId: "run-one",
        channel: "telegram",
        attachments: [{ kind: "image", name: "photo.png", mime: "image/png" }],
      },
    },
  ]);
  assert.deepEqual(customMessages, [
    {
      message: {
        customType: "pi-desktop-channel-attachment-context",
        content: "Attachment 1 is available at /tmp/file.txt",
        display: false,
      },
      options: { deliverAs: "nextTurn" },
    },
  ]);
  assert.equal(progress[0].message.channelSource, "telegram");
  assert.deepEqual(progress[0].message.channelAttachments, [{ kind: "image", name: "photo.png", mime: "image/png" }]);
  assert.deepEqual(
    progress.map((event) => event.type),
    ["message_end", "message_update"],
  );
});

test("session tool changes use Desktop persistence and can enable tools after an empty initialization", async (t) => {
  const persistedStates = [];
  let activeToolNames = [];
  const inner = {
    sessionId: "session-tools",
    sessionFile: "/tmp/session-tools.jsonl",
    sessionManager: {
      getHeader: () => ({ cwd: "/tmp" }),
    },
    agent: { state: { messages: [], systemPrompt: "initial" } },
    getAllTools: () => [
      { name: "read", description: "Read" },
      { name: "bash", description: "Bash" },
    ],
    getActiveToolNames: () => [...activeToolNames],
    setActiveToolsByName(toolNames) {
      activeToolNames = [...toolNames];
      this.agent.state.systemPrompt = toolNames.length > 0 ? "tools enabled" : "no tools";
    },
  };
  const wrapper = new AgentSessionWrapper(inner, [], (sessionId, toolNames) => {
    persistedStates.push({ sessionId, toolNames: [...toolNames] });
  });
  t.after(() => wrapper.destroy());

  assert.equal(inner.agent.state.systemPrompt, "");
  await wrapper.send({ type: "set_tools", toolNames: ["read", "bash"] });
  assert.deepEqual(activeToolNames, ["read", "bash"]);
  assert.equal(inner.agent.state.systemPrompt, "tools enabled");
  assert.deepEqual(persistedStates.at(-1), { sessionId: "session-tools", toolNames: ["read", "bash"] });

  await wrapper.send({ type: "set_tools", toolNames: [] });
  assert.deepEqual(activeToolNames, []);
  assert.equal(inner.agent.state.systemPrompt, "");
  assert.deepEqual(persistedStates.at(-1), { sessionId: "session-tools", toolNames: [] });
});

test("legacy JSONL session tools use the latest valid state for sidecar migration", () => {
  const entries = [
    { type: "custom", customType: "pi-desktop-session-tools", data: { version: 1, toolNames: ["read"] } },
    { type: "custom", customType: "other", data: { version: 1, toolNames: ["bash"] } },
    { type: "custom", customType: "pi-desktop-session-tools", data: { version: 2, toolNames: ["write"] } },
    {
      type: "custom",
      customType: "pi-desktop-session-tools",
      data: { version: 1, toolNames: [" bash ", "bash", "edit"] },
    },
  ];
  assert.deepEqual(getLegacySessionToolNames({ getEntries: () => entries }), ["bash", "edit"]);
});

test("session destroy notifies every teardown owner once and isolates failures", () => {
  const wrapper = new AgentSessionWrapper({
    sessionId: "destroy-session",
    sessionManager: { getHeader: () => ({ cwd: "/tmp" }) },
    agent: { state: { messages: [] } },
  });
  const calls = [];
  wrapper.onDestroy(() => calls.push("registry"));
  wrapper.onDestroy(() => {
    calls.push("failing-owner");
    throw new Error("teardown failed");
  });
  wrapper.onDestroy(() => calls.push("event-binding"));
  const cancel = wrapper.onDestroy(() => calls.push("cancelled"));
  cancel();

  wrapper.destroy();
  wrapper.destroy();
  assert.deepEqual(calls, ["registry", "failing-owner", "event-binding"]);

  wrapper.onDestroy(() => calls.push("late-owner"));
  assert.deepEqual(calls, ["registry", "failing-owner", "event-binding", "late-owner"]);
});

test("a transient extension binding failure is retried by the next prompt", async (t) => {
  let bindCalls = 0;
  const prompts = [];
  const inner = {
    sessionId: "extension-retry-session",
    sessionManager: { getHeader: () => ({ cwd: "/tmp" }) },
    agent: { state: { messages: [] } },
    extensionRunner: {},
    async bindExtensions() {
      bindCalls += 1;
      if (bindCalls === 1) throw new Error("temporary extension failure");
    },
    async prompt(message) {
      prompts.push(message);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  await assert.rejects(wrapper.ensureExtensionsBound(), /temporary extension failure/);
  assert.equal(wrapper.extensionBindingPromise, null);
  await wrapper.send({ type: "prompt", message: "retry succeeds" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bindCalls, 2);
  assert.deepEqual(prompts, ["retry succeeds"]);
  assert.equal(wrapper.extensionBindingError, null);
});

test("concurrent session disposal aborts and releases the inner agent exactly once", async () => {
  const calls = [];
  const wrapper = new AgentSessionWrapper({
    sessionId: "dispose-session",
    sessionManager: { getHeader: () => ({ cwd: "/tmp" }) },
    agent: {
      state: { messages: [] },
      async waitForIdle() {
        calls.push("waitForIdle");
      },
      async dispose() {
        calls.push("dispose");
      },
    },
    async abort() {
      calls.push("abort");
    },
  });
  let destroyed = 0;
  wrapper.onDestroy(() => destroyed++);

  await Promise.all([
    wrapper.dispose({ abort: true, reason: "test" }),
    wrapper.dispose({ abort: true, reason: "duplicate" }),
    wrapper.abortAndDispose(),
  ]);

  assert.deepEqual(calls, ["abort", "waitForIdle", "dispose"]);
  assert.equal(destroyed, 1);
  assert.equal(wrapper.isAlive(), false);
});
