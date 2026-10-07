import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
const {
  SessionToolPolicy,
  SessionExecutionHistory,
  SessionPromptPolicy,
  desktopSessionExtensions,
  initializeMcpService,
  getDefaultStore,
  setAgentSessionSource,
} = await importTestBundle("mcp-upgrade-pipeline", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {SessionToolPolicy} from '../session-tool-policy.ts';
    export {SessionExecutionHistory} from '../session-execution-history.ts';
    export {SessionPromptPolicy} from '../session-prompt-policy.ts';
    export {desktopSessionExtensions} from '../desktop-session-extensions.ts';
    export {initializeMcpService} from './runtime.ts';
    export {getDefaultStore} from '../session-tool-store.ts';
    export {setAgentSessionSource} from '../session-source.ts';`,
  },
});

test(
  "real Desktop SDK pipeline discovers delayed canonical tools, binds grants, reloads and preserves raw history",
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-upgrade-pipeline-"));
    const environment = {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_DESKTOP_USER_DATA: process.env.PI_DESKTOP_USER_DATA,
    };
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_DESKTOP_USER_DATA = path.join(root, "desktop");
    const gate = createDeferred(),
      rawCalls = [];
    let reverse = false,
      session;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        if (request.url === "/fail") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32603, message: "Fixture initialization failed" },
            }),
          );
          return;
        }
        let result;
        if (body.method === "initialize") {
          await gate.promise;
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "upgrade", version: "1" },
            instructions: "LONG_NAMESPACE_INSTRUCTIONS",
          };
        } else if (body.method === "tools/list") {
          const names = ["read-file", "read_file"];
          result = {
            tools: (reverse ? names.reverse() : names).map((name) => ({
              name,
              description: "Read fixture data",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            })),
          };
        } else if (body.method === "tools/call") {
          rawCalls.push(body.params.name);
          result = {
            content: [{ type: "text", text: body.params.name }],
            structuredContent: { rawName: body.params.name },
            _meta: { unchanged: true },
          };
        } else result = {};
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      })().catch((error) => {
        response.writeHead(500).end(String(error));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const mcp = initializeMcpService({ emit() {} });
    t.after(async () => {
      gate.resolve();
      session?.dispose();
      await mcp.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });
    await mcp.config.upsert(
      "global",
      undefined,
      "dev-server",
      {
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        description: "SHORT_CONFIG_SUMMARY",
        exposure: "codemode",
      },
      "missing",
    );
    const manager = SessionManager.create(root, path.join(root, "sessions")),
      id = manager.getSessionId();
    setAgentSessionSource(manager, "local");
    const selected = ["read", "codemode", "tool_search"],
      policy = new SessionToolPolicy(manager, selected),
      promptPolicy = new SessionPromptPolicy(false);
    promptPolicy.setToolchainSummary(1, ["UPGRADE_TOOLCHAIN_SUMMARY"]);
    const history = new SessionExecutionHistory(manager, path.join(root, "desktop"));
    await history.recover();
    getDefaultStore().set(id, selected);
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: desktopSessionExtensions(policy, history, promptPolicy, () => false),
      },
    });
    await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-upgrade-fixture");
    ({ session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
    }));
    policy.bind(session);
    session.setActiveToolsByName(selected);
    await session.bindExtensions({ mode: "rpc" });
    const contexts = [];
    let turn = 0,
      firstProviderAt = 0,
      script =
        'text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__dev_server__"))); text(await describeNamespace("mcp__dev_server"));';
    session.agent.streamFunction = (model, context) => {
      contexts.push(context);
      if (!firstProviderAt) firstProviderAt = Date.now();
      gate.resolve();
      const first = ++turn === 1,
        stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content:
          first && script
            ? [{ type: "toolCall", id: "upgrade-" + contexts.length, name: "codemode", arguments: { code: script } }]
            : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: first && script ? "toolUse" : "stop",
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
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    };
    const firstPromptAt = Date.now();
    await session.prompt("Discover the delayed fixture", { source: "rpc" });
    assert.ok(
      firstProviderAt - firstPromptAt < 2500,
      "a deferred MCP connection must not consume the 10-second direct startup wait",
    );
    const system = contexts[0].systemPrompt ?? getCurrentSystemPrompt(contexts[0].messages);
    assert.match(system, /<mcp_servers>[\s\S]*SHORT_CONFIG_SUMMARY/);
    assert.match(system, /UPGRADE_TOOLCHAIN_SUMMARY/);
    assert.doesNotMatch(system, /LONG_NAMESPACE_INSTRUCTIONS/);
    const discoveryResult = manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
      .at(-1).message;
    assert.match(JSON.stringify(discoveryResult), /LONG_NAMESPACE_INSTRUCTIONS/);
    const tools = mcp.tools(id);
    const discoveryTools = contexts.at(-1).tools ?? getCurrentTools(contexts.at(-1).messages);
    assert.equal(
      discoveryTools.some((tool) => tool.name.startsWith("mcp__")),
      false,
    );
    assert.doesNotMatch(
      discoveryTools.find((tool) => tool.name === "codemode").description,
      /mcp__dev_server__read_file_|LONG_NAMESPACE_INSTRUCTIONS/,
    );
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].name, tools[1].name);
    for (const tool of tools) {
      assert.match(tool.name, /^mcp__dev_server__read_file_[a-f0-9]{8}$/);
      assert.equal(policy.isAllowed(tool.name), false);
    }
    assert.deepEqual(rawCalls, []);
    mcp.grant(
      id,
      tools.map((tool) => tool.name),
    );
    script = tools.map((tool) => `text(await tools.${tool.name}({text:"ORIGINAL_ARGS"}));`).join("\n");
    turn = 0;
    await session.prompt("Call both granted tools", { source: "rpc" });
    assert.deepEqual(rawCalls.sort(), ["read-file", "read_file"]);
    reverse = true;
    await mcp.getConnection(id, "dev-server").refreshTools();
    assert.deepEqual(
      mcp
        .tools(id)
        .map((tool) => tool.name)
        .sort(),
      tools.map((tool) => tool.name).sort(),
    );
    const beforeReload = readFileSync(manager.getSessionFile(), "utf8");
    await session.reload();
    // Desktop's reloadSessionResources rebinds extension UI/session hooks after SDK reload.
    await session.bindExtensions({ mode: "rpc" });
    const deadline = Date.now() + 3000;
    while (mcp.snapshot(id)[0]?.state !== "connected") {
      if (Date.now() > deadline) throw new Error("reload failed to reconnect");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(tools.every((tool) => policy.isAllowed(tool.name)));
    assert.equal(
      readFileSync(manager.getSessionFile(), "utf8"),
      beforeReload,
      "grant migration and reconnect never rewrite JSONL",
    );
    mcp.grant(id, []);
    assert.ok(tools.every((tool) => !policy.isAllowed(tool.name)));
    turn = 0;
    await session.prompt("Attempt after revoke", { source: "rpc" });
    assert.equal(rawCalls.length, 2);
    const records = (await history.query({ includeContent: true, maxContentBytes: 2097152 })).records;
    assert.ok(records.some((record) => record.result?.value?.details?.mcp?.tool === "read-file"));
    assert.ok(records.some((record) => record.result?.value?.details?.mcp?.tool === "read_file"));
    const configuration = await mcp.config.snapshot("global");
    await mcp.config.upsert(
      "global",
      undefined,
      "offline",
      { url: `http://127.0.0.1:${server.address().port}/fail`, description: "UNAVAILABLE_FIXTURE" },
      configuration.revision,
    );
    await mcp.changed("global");
    const failureDeadline = Date.now() + 3000;
    while (mcp.snapshot(id).find((item) => item.name === "offline")?.state !== "failed") {
      if (Date.now() > failureDeadline) throw new Error("fixture failure did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    script = 'text(ALL_TOOLS.filter(t=>t.name.startsWith("mcp__offline__")));';
    turn = 0;
    await session.prompt("Discover the unavailable server", { source: "rpc" });
    const incomplete = manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
      .at(-1).message;
    assert.match(JSON.stringify(incomplete), /MCP catalog is incomplete: mcp__offline \(failed\)/);
    assert.equal(rawCalls.length, 2);
    getDefaultStore().set(id, []);
    policy.setRequested([]);
    promptPolicy.setForceEmpty(true);
    session.setActiveToolsByName([]);
    script = "";
    turn = 0;
    await session.prompt("Empty tools", { source: "rpc" });
    const last = contexts.at(-1);
    assert.equal(last.systemPrompt ?? getCurrentSystemPrompt(last.messages), "");
    assert.deepEqual(
      (last.tools ?? getCurrentTools(last.messages)).map((tool) => tool.name),
      [],
    );
  },
);
