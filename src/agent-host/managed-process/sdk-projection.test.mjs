import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { importTestBundle } from "#test-bundle";

const {
  ManagedProcessService,
  createManagedProcessToolDefinitions,
  setAgentSessionSource,
  installManagedProcessSessionRedaction,
  SessionEphemeralContext,
  createEphemeralContextExtension,
  AgentSessionWrapper,
} = await importTestBundle("pi-managed-process-sdk-projection", {
  packages: "external",
  stdin: {
    contents: [
      'export { ManagedProcessService } from "./service.ts";',
      'export { createManagedProcessToolDefinitions } from "./tools.ts";',
      'export { setAgentSessionSource } from "../session-source.ts";',
      'export { installManagedProcessSessionRedaction } from "./session-redaction.ts";',
      'export { SessionEphemeralContext, createEphemeralContextExtension } from "../session-ephemeral-context.ts";',
      'export { AgentSessionWrapper } from "../rpc-manager.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "managed-process-sdk-projection-entry.ts",
    loader: "ts",
  },
});

function assistant(model, content, stopReason) {
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
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void Promise.resolve().then(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

test("real process readiness and an aborted wait use live SDK context without leaking JSONL", async (t) => {
  if (process.platform === "win32") return t.skip("Windows helper requires its target-host integration suite");
  const directory = mkdtempSync(path.join(tmpdir(), "pi-managed-sdk-projection-"));
  const script = path.join(directory, "ready.mjs");
  const readiness = "PI_READY";
  const secretResult = "PI_MANAGED_RESULT_42";
  writeFileSync(script, `process.stdout.write("${readiness} ${secretResult}\\n"); setInterval(() => {}, 1000);\n`);
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const workerEntry = path.join(import.meta.dirname, "worker.ts");
  const runtime = {
    async createExecutionContext() {
      return {
        inventoryRevision: 1,
        resolutionId: "process-sdk-fixture",
        nativeEnv: { ...process.env },
        shellEnv: { ...process.env },
        commands: {
          "shell.bash": {
            capability: "shell.bash",
            provider: "system",
            executable: "/bin/bash",
            argvPrefix: [],
            binDir: "/bin",
            cwdSemantics: "native",
            envPatch: {},
          },
        },
        summary: [],
      };
    },
    requireFromContext(_capability, context) {
      return context.commands["shell.bash"];
    },
  };
  let journalRevision = 0;
  const service = new ManagedProcessService(
    { emit() {} },
    {
      platform: process.platform,
      runtime,
      workerEntryPath: workerEntry,
      workerExecArgv: ["--experimental-strip-types"],
      parentCall: async (method) => {
        if (method === "managedProcesses.getSettings") return { enabled: true, reaperReady: true };
        if (method === "managedProcesses.register") return { journalRevision: ++journalRevision };
        if (method === "managedProcesses.unregister") return { journalRevision: ++journalRevision, removed: true };
        throw new Error(`Unexpected parent call: ${method}`);
      },
    },
  );
  let session;
  let wrapper;
  let ephemeral;
  t.after(async () => {
    if (wrapper) await wrapper.dispose();
    else session?.dispose();
    ephemeral?.dispose();
    await service.stopAll("host");
    rmSync(directory, { recursive: true, force: true });
  });

  const manager = SessionManager.create(directory, directory);
  setAgentSessionSource(manager, "local");
  installManagedProcessSessionRedaction(manager);
  ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off" }),
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
  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    tools: ["process_start", "process_wait", "process_stop"],
    customTools: createManagedProcessToolDefinitions(directory, true, service),
  }));
  await session.bindExtensions({ mode: "rpc" });

  const requests = [];
  let started;
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(structuredClone(context));
    if (requests.length === 1) {
      return assistant(
        requestModel,
        [
          {
            type: "toolCall",
            id: "start-fixture",
            name: "process_start",
            arguments: {
              command,
              kind: "task",
              waitFor: { type: "output", contains: readiness, timeoutMs: 10_000 },
              activateUi: false,
            },
          },
        ],
        "toolUse",
      );
    }
    if (requests.length === 2) {
      const result = context.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "process_start",
      );
      assert.ok(result);
      const raw = result.content[0].text;
      assert.match(raw, /PI_MANAGED_RESULT_42/);
      started = JSON.parse(raw);
      assert.ok(started.process.processId);
      assert.ok(started.process.runId);
      return assistant(
        requestModel,
        [
          {
            type: "toolCall",
            id: "stop-fixture",
            name: "process_stop",
            arguments: { processId: started.process.processId, runId: started.process.runId },
          },
        ],
        "toolUse",
      );
    }
    return assistant(requestModel, [{ type: "text", text: "Fixture process stopped" }], "stop");
  };

  await session.prompt("Start the fixture process and stop it after readiness", { source: "rpc" });
  assert.equal(requests.length, 3);
  assert.equal(session.getLastAssistantText(), "Fixture process stopped");
  assert.ok(started);
  assert.equal(started.readiness.state, "ready");
  const stopResult = requests[2].messages.find(
    (message) => message.role === "toolResult" && message.toolName === "process_stop",
  );
  assert.ok(stopResult);
  assert.notEqual(stopResult.isError, true);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.equal(persisted.includes(secretResult), false);
  assert.match(persisted, /Sensitive managed process result was not saved/);

  wrapper = new AgentSessionWrapper(session, undefined, () => undefined, undefined, ephemeral);
  wrapper.start();
  const waitForEvent = (predicate, label) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} was not observed`)), 10_000);
      const unsubscribe = wrapper.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      });
    });
  let secondPhaseRequests = 0;
  session.agent.streamFunction = (requestModel, context) => {
    secondPhaseRequests++;
    if (secondPhaseRequests === 1) {
      return assistant(
        requestModel,
        [
          {
            type: "toolCall",
            id: "start-before-abort",
            name: "process_start",
            arguments: {
              command,
              kind: "task",
              waitFor: { type: "output", contains: readiness, timeoutMs: 10_000 },
              activateUi: false,
            },
          },
        ],
        "toolUse",
      );
    }
    if (secondPhaseRequests === 2) {
      const result = context.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "start-before-abort",
      );
      assert.ok(result);
      const current = JSON.parse(result.content[0].text);
      return assistant(
        requestModel,
        [
          {
            type: "toolCall",
            id: "wait-until-abort",
            name: "process_wait",
            arguments: {
              processId: current.process.processId,
              runId: current.process.runId,
              contains: "NEVER_MATCH_THIS_OUTPUT",
              timeoutMs: 10_000,
            },
          },
        ],
        "toolUse",
      );
    }
    return assistant(requestModel, [{ type: "text", text: "unexpected continuation" }], "stop");
  };
  const waiting = waitForEvent(
    (event) => event.type === "tool_execution_start" && event.toolName === "process_wait",
    "live process wait",
  );
  const abortedDone = waitForEvent(
    (event) => event.type === "prompt_done" && event.clientRunId === 77,
    "aborted prompt completion",
  );
  await wrapper.send({ type: "prompt", message: "Wait for output that will not arrive", clientRunId: 77 });
  await waiting;
  await wrapper.send({ type: "abort" });
  await abortedDone;
  assert.equal(ephemeral.shouldStopCacheWarming(), true);

  const afterAbortRequests = [];
  session.agent.streamFunction = (requestModel, context) => {
    afterAbortRequests.push(structuredClone(context));
    return assistant(requestModel, [{ type: "text", text: "safe after abort" }], "stop");
  };
  const nextDone = waitForEvent(
    (event) => event.type === "prompt_done" && event.clientRunId === 78,
    "post-abort prompt completion",
  );
  await wrapper.send({ type: "prompt", message: "Continue after stopping the wait", clientRunId: 78 });
  await nextDone;
  assert.equal(afterAbortRequests.length, 1);
  assert.equal(JSON.stringify(afterAbortRequests[0].messages).includes(secretResult), false);
  assert.equal(readFileSync(sessionFile, "utf8").includes(secretResult), false);
});
