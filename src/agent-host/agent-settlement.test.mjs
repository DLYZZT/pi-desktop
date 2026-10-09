import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { createAgentSettlementExtension, buildSessionHistoryPage, readSessionSnapshot } = await importTestBundle(
  "agent-settlement",
  {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: `
    export {createAgentSettlementExtension} from './agent-settlement.ts';
    export {buildSessionHistoryPage} from './session-history.ts';
    export {readSessionSnapshot} from './session-readonly.ts';`,
    },
  },
);
const usage = {
  input: 1,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const cancel of [true, false]) {
  test(`SDK settlement ${cancel ? "annotates cancellation" : "preserves provider failure"} without rewriting messages or leaking to another branch`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-settlement-"));
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
    await runtime.setRuntimeApiKey("anthropic", "fixture");
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
      resourceLoaderOptions: {
        noSkills: true,
        noContextFiles: true,
        noThemes: true,
        noPromptTemplates: true,
        extensionFactories: [createAgentSettlementExtension()],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      tools: [],
      model: runtime.getModel("anthropic", "claude-sonnet-5-5"),
    });
    t.after(() => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    await session.bindExtensions({ mode: "rpc" });
    const entered = createDeferred();
    const settled = [];
    session.subscribe((event) => {
      if (event.type === "agent_settled") settled.push(event);
    });
    session.agent.streamFunction = (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        api: model.api,
        content: [{ type: "text", text: "Partial original reply" }],
        stopReason: "error",
        errorMessage: "This operation was aborted",
        timestamp: Date.now(),
        usage,
      };
      const finish = () => {
        stream.push({ type: "error", reason: "error", error: message });
        stream.end();
      };
      globalThis.queueMicrotask(() => {
        if (cancel) {
          options.signal.addEventListener("abort", finish, { once: true });
          if (options.signal.aborted) finish();
        } else finish();
        entered.resolve();
      });
      return stream;
    };
    const work = session.prompt("Fixture", { source: "rpc" });
    await entered.promise;
    if (cancel) await session.abort();
    await work;
    assert.equal(settled.at(-1).aborted, cancel);
    const filename = manager.getSessionFile();
    const original = readFileSync(filename, "utf8");
    const snapshot = readSessionSnapshot(filename);
    const entries = snapshot.getEntries();
    const assistant = entries.find((e) => e.type === "message" && e.message.role === "assistant");
    assert.equal(assistant.message.stopReason, "error");
    assert.equal(assistant.message.errorMessage, "This operation was aborted");
    for (const historyWindow of [undefined, { maxTurns: 20, maxBytes: 100000 }]) {
      const page = buildSessionHistoryPage({ entries, historyWindow, historyRevision: "fixture" });
      const shown = page.messages.find((m) => m.role === "assistant");
      assert.equal(shown.stopReason, cancel ? "aborted" : "error");
      assert.equal(shown.content[0].text, "Partial original reply");
      const beforeMarker = buildSessionHistoryPage({
        entries,
        leafId: assistant.id,
        historyWindow,
        historyRevision: "fixture",
      });
      assert.equal(beforeMarker.messages.find((m) => m.role === "assistant").stopReason, "error");
    }
    assert.equal(readFileSync(filename, "utf8"), original, "history reads never rewrite the original error");
    assert.equal(entries.filter((e) => e.customType === "pi-desktop-agent-settled").length, cancel ? 1 : 0);
  });
}
