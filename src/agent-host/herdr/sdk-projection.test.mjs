import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const binary =
  process.env.HERDR_E2E_BINARY ??
  path.join(projectRoot, "build", "herdr", "bin", `${process.platform}-${process.arch}`, "herdr");
const skip =
  process.platform === "win32"
    ? "Herdr transport is not supported on Windows"
    : !existsSync(binary)
      ? "Prepare the pinned Herdr runtime before running its SDK integration test"
      : false;

const {
  HerdrBridge,
  __test,
  createHerdrToolDefinitions,
  setAgentSessionSource,
  installHerdrSessionRedaction,
  SessionEphemeralContext,
  createEphemeralContextExtension,
} = await importTestBundle("pi-herdr-sdk-projection", {
  packages: "external",
  stdin: {
    contents: [
      'export { HerdrBridge, __test } from "./bridge.ts";',
      'export { createHerdrToolDefinitions } from "./tools.ts";',
      'export { setAgentSessionSource } from "../session-source.ts";',
      'export { installHerdrSessionRedaction } from "./session-redaction.ts";',
      'export { SessionEphemeralContext, createEphemeralContextExtension } from "../session-ephemeral-context.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "herdr-sdk-projection-entry.ts",
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

async function waitForSocket(endpoint, server, getOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(endpoint)) return;
    if (server.exitCode !== null) throw new Error(`Herdr server exited early: ${getOutput()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Herdr socket did not appear: ${getOutput()}`);
}

test("real Herdr fleet and pane results reach later SDK requests without entering JSONL", { skip }, async (t) => {
  const root = mkdtempSync(path.join("/tmp", "pi-herdr-sdk-"));
  const agentDir = path.join(root, "pi-agent");
  const configHome = path.join(root, "config");
  const stateHome = path.join(root, "state");
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  for (const directory of [agentDir, configHome, stateHome, home, cwd]) mkdirSync(directory, { recursive: true });
  const sessionName = `pi-sdk-${process.pid}`;
  const endpoint = path.join(configHome, "herdr", "sessions", sessionName, "herdr.sock");
  const childEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    LANG: "C.UTF-8",
  };
  const server = spawn(binary, ["--session", sessionName, "server"], {
    env: childEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-4096);
    });
  }
  let bridge;
  let session;
  let ephemeral;
  t.after(async () => {
    session?.dispose();
    ephemeral?.dispose();
    await bridge?.shutdown();
    if (server.exitCode === null) {
      const stopper = spawn(binary, ["--session", sessionName, "server", "stop"], {
        env: childEnv,
        shell: false,
        stdio: "ignore",
      });
      await Promise.race([once(stopper, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (stopper.exitCode === null) stopper.kill("SIGKILL");
      await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitForSocket(endpoint, server, () => serverOutput);

  bridge = new HerdrBridge({ emit() {} }, { assertAllowedPath: async () => undefined });
  __test.applyRuntimeDescriptor({
    revision: 1,
    enabled: true,
    mode: "attach",
    sessionName,
    autoConnect: true,
    releaseControlOnViewClose: true,
    executable: binary,
    endpoint,
    binarySource: "custom",
    version: "0.8.2",
    protocol: 20,
    schemaVersion: 1,
  });
  assert.equal((await bridge.connect()).status, "ready");
  const workspaceLabel = "PI_HERDR_FLEET_42";
  const created = await bridge.createWorkspace(cwd, workspaceLabel);
  assert.ok(created.rootPaneId);

  const manager = SessionManager.create(cwd, agentDir);
  setAgentSessionSource(manager, "local");
  installHerdrSessionRedaction(manager);
  ephemeral = new SessionEphemeralContext(manager);
  ephemeral.install();
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
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
    tools: ["herdr_status", "herdr_list", "herdr_pane_read"],
    customTools: createHerdrToolDefinitions(cwd, bridge),
  }));
  await session.bindExtensions({ mode: "rpc" });

  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(structuredClone(context));
    if (requests.length === 1) {
      return assistant(
        requestModel,
        [{ type: "toolCall", id: "status", name: "herdr_status", arguments: {} }],
        "toolUse",
      );
    }
    if (requests.length === 2) {
      const result = context.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "herdr_status",
      );
      assert.ok(result);
      assert.equal(JSON.parse(result.content[0].text).status, "ready");
      return assistant(requestModel, [{ type: "toolCall", id: "list", name: "herdr_list", arguments: {} }], "toolUse");
    }
    if (requests.length === 3) {
      const result = context.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "herdr_list",
      );
      assert.ok(result);
      const fleet = JSON.parse(result.content[0].text);
      assert.match(result.content[0].text, /PI_HERDR_FLEET_42/);
      assert.equal(
        fleet.panes.some((pane) => pane.id === created.rootPaneId),
        true,
      );
      return assistant(
        requestModel,
        [
          {
            type: "toolCall",
            id: "read",
            name: "herdr_pane_read",
            arguments: { paneId: created.rootPaneId },
          },
        ],
        "toolUse",
      );
    }
    const result = context.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "herdr_pane_read",
    );
    assert.ok(result);
    assert.notEqual(result.isError, true);
    return assistant(requestModel, [{ type: "text", text: "Herdr pane inspected" }], "stop");
  };

  await session.prompt("Inspect the fixture Herdr workspace", { source: "rpc" });
  assert.equal(requests.length, 4);
  assert.equal(session.getLastAssistantText(), "Herdr pane inspected");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const persisted = readFileSync(sessionFile, "utf8");
  assert.equal(persisted.includes(workspaceLabel), false);
  assert.equal(persisted.includes(endpoint), false);
  assert.match(persisted, /Sensitive Herdr result was not saved/);
});
