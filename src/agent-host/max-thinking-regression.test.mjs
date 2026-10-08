import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

test("real SDK sends max, restores it from history and clamps it when switching to an unsupported model", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-max-"));
  const sessions = [];
  t.after(() => {
    for (const session of sessions) session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {},
      async list() {
        return [];
      },
      async modify() {
        throw Error("read-only");
      },
      async delete() {
        throw Error("read-only");
      },
    },
  });
  const model = runtime.getModels("openai").find((model) => getSupportedThinkingLevels(model).includes("max"));
  assert.ok(model);
  await runtime.setRuntimeApiKey("openai", "synthetic-max-test");
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
  });
  const manager = SessionManager.create(root, root);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [] });
  sessions.push(session);
  session.setThinkingLevel("max");
  let reasoning;
  session.agent.streamFunction = (selected, _context, options) => {
    reasoning = options.reasoning;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "max fixture" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await session.prompt("Verify max", { source: "rpc" });
  assert.equal(reasoning, "max");
  const restored = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.open(manager.getSessionFile()),
    tools: [],
  });
  sessions.push(restored.session);
  assert.equal(restored.session.thinkingLevel, "max");
  await restored.session.setModel(runtime.getModel("openai", "gpt-4o"));
  assert.equal(restored.session.thinkingLevel, "off");
});
