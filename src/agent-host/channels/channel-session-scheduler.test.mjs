import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `channel-session-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { AgentSessionWrapper } from "../rpc-manager.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "channel-session-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { AgentSessionWrapper } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

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
    { customType: "pi-desktop-channel-source", data: { runId: "run-one", channel: "telegram" } },
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
  assert.deepEqual(
    progress.map((event) => event.type),
    ["message_end", "message_update"],
  );
});
