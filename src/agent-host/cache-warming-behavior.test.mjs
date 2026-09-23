import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const provider = "pi-desktop-warming-fixture";
const modelId = "warmable-model";

function response(model, content, stopReason = "stop") {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 100_000,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100_001,
      cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    },
  };
  void Promise.resolve().then(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

async function fixture(t, mode, slowTool = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-warming-behavior-"));
  const manager = SessionManager.inMemory(directory);
  let ordinaryRequests = 0;
  let warmRequests = 0;
  let releaseTool;
  let toolStartedResolve;
  const toolStarted = new Promise((resolve) => {
    toolStartedResolve = resolve;
  });
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ cacheWarming: mode }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "warming-provider-fixture",
          factory(pi) {
            pi.registerProvider(provider, {
              name: "Warming fixture",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:0",
              apiKey: "offline-fixture-key",
              models: [
                {
                  id: modelId,
                  name: "Warmable fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 10, output: 0, cacheRead: 0, cacheWrite: 10 },
                  contextWindow: 1_000_000,
                  maxTokens: 2048,
                  promptCache: { short: 20 },
                },
              ],
              streamSimple(model, _context, options) {
                if (options?.maxTokens === 1) {
                  warmRequests++;
                  return response(model, [{ type: "text", text: "warm" }]);
                }
                ordinaryRequests++;
                return slowTool && ordinaryRequests === 1
                  ? response(
                      model,
                      [{ type: "toolCall", id: "slow-call", name: "slow_tool", arguments: {} }],
                      "toolUse",
                    )
                  : response(model, [{ type: "text", text: "done" }]);
              },
            });
          },
        },
      ],
    },
  });
  const model = services.modelRuntime.getModel(provider, modelId);
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    tools: slowTool ? ["slow_tool"] : [],
    customTools: slowTool
      ? [
          {
            name: "slow_tool",
            label: "Slow tool",
            description: "Keeps the agent streaming across a cache refresh",
            parameters: Type.Object({}),
            execute: async () => {
              toolStartedResolve();
              await toolGate;
              return { content: [{ type: "text", text: "ready" }] };
            },
          },
        ]
      : [],
  });
  await session.bindExtensions({ mode: "rpc" });
  t.after(() => {
    releaseTool();
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { session, manager, toolStarted, releaseTool, counts: () => ({ ordinaryRequests, warmRequests }) };
}

test("off never refreshes a completed SDK request, while idle records a separate usage entry", async (t) => {
  const off = await fixture(t, "off");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await off.session.prompt("Off mode", { source: "rpc" });
  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(off.counts().warmRequests, 0);
  assert.equal(
    off.manager.getEntries().some((entry) => entry.type === "usage"),
    false,
  );
  t.mock.timers.reset();

  const idle = await fixture(t, "idle");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await idle.session.prompt("Idle mode", { source: "rpc" });
  assert.equal(idle.session.cacheWarmingStatus?.state, "scheduled");
  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(idle.counts().warmRequests, 1);
  assert.equal(idle.manager.getEntries().filter((entry) => entry.type === "usage").length, 1);
  idle.session.setCacheWarmingMode("off");
  t.mock.timers.tick(20_000);
  await new Promise(setImmediate);
  assert.equal(idle.counts().warmRequests, 1);
  t.mock.timers.reset();
});

test("streaming refreshes during a long tool and stops when the SDK run settles", async (t) => {
  const context = await fixture(t, "streaming", true);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pending = context.session.prompt("Use the slow tool", { source: "rpc" });
  await context.toolStarted;
  assert.equal(context.session.cacheWarmingStatus?.state, "scheduled");
  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(context.counts().warmRequests, 1);
  context.releaseTool();
  await pending;
  assert.equal(context.session.cacheWarmingStatus?.state, "inactive");
  t.mock.timers.tick(20_000);
  await new Promise(setImmediate);
  assert.equal(context.counts().warmRequests, 1);
  t.mock.timers.reset();
});

test("idle mode does not send a stale refresh after a long inactive interval", async (t) => {
  const context = await fixture(t, "idle");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await context.session.prompt("Idle safety window", { source: "rpc" });
  assert.equal(context.session.cacheWarmingStatus?.state, "scheduled");
  t.mock.timers.setTime(31 * 60_000);
  t.mock.timers.tick(10_000);
  await new Promise(setImmediate);
  assert.equal(context.counts().warmRequests, 0);
  assert.equal(context.session.cacheWarmingStatus?.state, "inactive");
  t.mock.timers.reset();
});
