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
  const inner = {
    sessionId: "session-one",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {},
    settingsManager: {},
    agent: { state: {} },
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    async prompt(message) {
      order.push(`${message}-start`);
      if (message === "ui") await uiGate;
      last = `reply:${message}`;
      order.push(`${message}-end`);
    },
    getLastAssistantText: () => last,
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.extensionsBound = true;
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "ui" });
  const external = wrapper.runExternalTurn({ runId: "run-one", message: "im" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["ui-start"]);
  releaseUi();
  const result = await external;
  assert.deepEqual(order, ["ui-start", "ui-end", "im-start", "im-end"]);
  assert.equal(result.finalText, "reply:im");
});
