import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Type } from "typebox";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { importTestBundle } from "#test-bundle";
const { McpService, SessionExecutionHistory, SessionToolPolicy, setAgentSessionSource } = await importTestBundle(
  "mcp-sdk-pipeline",
  {
    packages: "external",
    stdin: {
      contents:
        'export {McpService} from "./service.ts"; export {SessionExecutionHistory} from "../session-execution-history.ts"; export {SessionToolPolicy} from "../session-tool-policy.ts"; export {setAgentSessionSource} from "../session-source.ts";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  },
);

for (const mode of ["nested", "codemode", "search"])
  test(`real SDK ${mode} MCP calls validate foreign schemas and preserve original results`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-sdk-")),
      manager = SessionManager.create(root, path.join(root, "sessions"));
    setAgentSessionSource(manager, "local");
    const policy = new SessionToolPolicy(manager, undefined, ["caller", "codemode", "tool_search"]);
    let mcpCalls = 0;
    const history = new SessionExecutionHistory(manager, path.join(root, "desktop"));
    await history.recover();
    const mcp = new McpService(
      {
        changed() {},
        oauth: { updated() {} },
        connection: {
          createTransport: async () => {
            const { client, server } = createInMemoryTransportPair();
            server.onMessage((request) => {
              if (request.id === undefined) return;
              if (request.method === "tools/call") mcpCalls++;
              const result =
                request.method === "initialize"
                  ? {
                      protocolVersion: request.params.protocolVersion,
                      capabilities: { tools: {} },
                      serverInfo: { name: "fixture", version: "1" },
                    }
                  : request.method === "tools/list"
                    ? {
                        tools: [
                          {
                            name: "echo",
                            inputSchema: {
                              type: "object",
                              properties: { text: { type: "string" } },
                              required: ["text"],
                            },
                          },
                        ],
                      }
                    : {
                        content: [
                          { type: "text", text: "RAW_MCP_" + request.params.arguments.text + "界".repeat(12000) },
                        ],
                        structuredContent: { original: request.params.arguments.text },
                        _meta: { originalMeta: true },
                      };
              void server.send({ jsonrpc: "2.0", id: request.id, result });
            });
            await server.start();
            return client;
          },
        },
      },
      root,
    );
    await mcp.config.upsert(
      "global",
      undefined,
      "fixture",
      { command: "fixture", exposure: mode === "search" ? "deferred" : "codemode" },
      "missing",
    );
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          history.extension(),
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
          { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
          {
            name: "mcp",
            builtin: true,
            replaceable: true,
            factory: (pi) => {
              pi.on("session_start", async (_event, ctx) =>
                mcp.attach({
                  pi,
                  ctx,
                  isEmpty: () => false,
                  isRunning: () => false,
                  isAllowed: (name) => policy.isAllowed(name),
                  setGrants: (names) => policy.setMcpExecution(names),
                }),
              );
            },
          },
          policy.extension(),
        ],
      },
    });
    await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-mcp-fixture");
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: services.modelRuntime.getModel("anthropic", "claude-sonnet-5-5"),
      customTools: [
        {
          name: "caller",
          label: "Caller",
          description: "Nested MCP fixture",
          parameters: Type.Object({}),
          execute: async (_id, _params, _signal, _update, ctx) =>
            (await ctx.executeTool("mcp__fixture__echo", { text: "原始参数" })).result,
        },
      ],
    });
    policy.bind(session);
    t.after(async () => {
      session.dispose();
      await mcp.shutdown();
      rmSync(root, { recursive: true, force: true });
    });
    session.setActiveToolsByName(["caller", "codemode", "tool_search"]);
    await session.bindExtensions({ mode: "rpc" });
    const deadline = Date.now() + 3000;
    while (mcp.snapshot(manager.getSessionId())[0]?.state !== "connected") {
      if (Date.now() > deadline) throw new Error("MCP session did not connect");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let calls = 0;
    assert.ok(
      session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo"),
      JSON.stringify(session.getAllTools().map((tool) => ({ name: tool.name, exposure: tool.exposure }))),
    );
    assert.ok(
      session.getCallableToolNames().includes("mcp__fixture__echo"),
      JSON.stringify(session.getCallableToolNames()),
    );
    session.agent.streamFunction = (model) => {
      const first = ++calls === 1,
        secondSearch = mode === "search" && calls === 2,
        stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: first
          ? [
              {
                type: "toolCall",
                id: "parent",
                name: mode === "nested" ? "caller" : mode === "search" ? "tool_search" : "codemode",
                arguments:
                  mode === "nested"
                    ? {}
                    : mode === "search"
                      ? { query: "fixture echo" }
                      : {
                          code: 'const result = await tools.mcp__fixture__echo({text: "原始参数"}); text(result.structuredContent.original); text("CODEMODE_FULL_" + "界".repeat(50000));',
                        },
              },
            ]
          : secondSearch
            ? [{ type: "toolCall", id: "direct-mcp", name: "mcp__fixture__echo", arguments: { text: "原始参数" } }]
            : [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: first || secondSearch ? "toolUse" : "stop",
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
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    };
    await session.prompt("Attempt MCP without a grant", { source: "rpc" });
    assert.equal(mcpCalls, 0);
    const denied = await history.query();
    assert.equal(denied.records.find((record) => record.toolName === "mcp__fixture__echo").status, "blocked");
    mcp.grant(manager.getSessionId(), ["mcp__fixture__echo", "codemode", "tool_search"]);
    calls = 0;
    await session.prompt("Call the granted MCP fixture", { source: "rpc" });
    assert.equal(mcpCalls, 1);
    const page = await history.query({ includeContent: true, maxContentBytes: 2097152 }),
      child = page.records.find((record) => record.toolName === "mcp__fixture__echo");
    assert.equal(child.status, "succeeded", JSON.stringify(child.result));
    assert.equal(child.parentToolCallId, mode === "search" ? undefined : "parent");
    assert.equal(child.arguments.value.text, "原始参数");
    assert.equal(child.result.value.structuredContent.structuredContent.original, "原始参数");
    assert.equal(child.result.value.structuredContent._meta.originalMeta, true);
    assert.ok(child.result.value.structuredContent.content[0].text.endsWith("界".repeat(12000)));
    assert.ok(Buffer.byteLength(child.result.value.content[0].text) <= 20 * 1024);
    assert.match(child.result.value.content[0].text, /tool_history_get/);
    if (mode === "codemode") {
      const parent = page.records.find((record) => record.toolName === "codemode");
      assert.equal(parent.output.complete, true);
      assert.ok(parent.output.value.includes("CODEMODE_FULL_" + "界".repeat(50000)));
      rmSync(parent.result.value.details.fullOutputPath);
      const reopened = new SessionExecutionHistory(
        SessionManager.open(manager.getSessionFile()),
        path.join(root, "desktop"),
      );
      const saved = await reopened.query({
        executionId: parent.executionId,
        includeContent: true,
        maxContentBytes: 2097152,
      });
      assert.equal(saved.records[0].output.value, parent.output.value);
      const exported = await history.store.exportBundle();
      assert.equal(exported.content[parent.output.ref.hash], parent.output.value);
    }
    mcp.grant(manager.getSessionId(), ["codemode", "tool_search"]);
    calls = 0;
    await session.prompt("Attempt MCP after revocation", { source: "rpc" });
    assert.equal(mcpCalls, 1);
    assert.ok(
      (await history.query()).records.some(
        (record) => record.toolName === "mcp__fixture__echo" && record.status === "blocked",
      ),
    );
  });
