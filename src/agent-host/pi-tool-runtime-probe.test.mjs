import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { importTestBundle } from "#test-bundle";
const { probePiToolRuntime } = await importTestBundle("pi-tool-runtime-probe", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "pi-tool-runtime-probe.ts")],
});

test("runtime validation executes the real QuickJS worker, MCP schemas and cancellation without model network or credential writes", async () => {
  const runtime = await ModelRuntime.create({
    credentials: {
      async read() {},
      async list() {
        return [];
      },
      async modify() {
        throw new Error("Unexpected credential write");
      },
      async delete() {
        throw new Error("Unexpected credential deletion");
      },
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let echoes = 0,
    waits = 0;
  const result = await probePiToolRuntime(runtime, {
    createTransport: async () => {
      const { client, server } = createInMemoryTransportPair();
      server.onMessage((request) => {
        if (request.id === undefined) return;
        let result;
        if (request.method === "initialize")
          result = {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
        else if (request.method === "tools/list")
          result = {
            tools: [
              { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
              { name: "wait", inputSchema: { type: "object", properties: {} } },
            ],
          };
        else if (request.params.name === "wait") {
          waits++;
          void server.send({ jsonrpc: "2.0", method: "notifications/runtime/wait" });
          return;
        } else {
          echoes++;
          result = {
            content: [{ type: "text", text: request.params.arguments.text }],
            structuredContent: { original: request.params.arguments.text },
          };
        }
        void server.send({ jsonrpc: "2.0", id: request.id, result });
      });
      await server.start();
      return client;
    },
  });
  assert.deepEqual(result, { codemodeMcpRoundTrip: true, codemodeCancellation: true, mcpStdioRoundTrip: true });
  assert.equal(echoes, 1);
  assert.equal(waits, 1);
});
