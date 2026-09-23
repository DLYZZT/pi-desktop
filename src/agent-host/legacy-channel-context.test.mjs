import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createLegacyChannelContextExtension } from "./legacy-channel-context.ts";

test("legacy IM wrappers remain in raw history but are removed from the next provider request", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-legacy-channel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(directory);
  const legacy = "[外部消息来源：微信]\n发送者标识：123\n---\nlegacy text";
  manager.appendMessage({ role: "user", content: [{ type: "text", text: legacy }], timestamp: 1 });
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createLegacyChannelContextExtension()],
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [] });
  t.after(() => session.dispose());
  let providerMessages;
  session.agent.streamFunction = (requestModel, context) => {
    providerMessages = context.messages;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
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
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("continue", { source: "rpc" });
  const original = providerMessages.filter((message) => message.role === "user")[0];
  assert.equal(original.content[0].text, "legacy text");
  const saved = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(saved.message.content[0].text, legacy);
});
