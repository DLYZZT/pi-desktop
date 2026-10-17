import assert from "node:assert/strict";
import test from "node:test";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createDeferred } from "#test-timing";

for (const mode of ["abort", "timeout"])
  test(`1.2.0 MCP ${mode} during token refresh never sends the cancelled call`, async (t) => {
    let hold = false;
    const entered = createDeferred(),
      release = createDeferred(),
      methods = [];
    const transport = new StreamableHttpTransport({
      url: "https://fixture.invalid/mcp",
      openGetStream: false,
      authProvider: {
        token: async () => {
          if (hold) {
            entered.resolve();
            await release.promise;
          }
          return "ROTATED_SYNTHETIC_TOKEN";
        },
      },
      fetch: async (_url, init) => {
        if (init.method === "DELETE") return new globalThis.Response(null, { status: 204 });
        const request = JSON.parse(init.body);
        methods.push(request.method);
        if (request.id === undefined) return new globalThis.Response(null, { status: 202 });
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { content: [] };
        return globalThis.Response.json({ jsonrpc: "2.0", id: request.id, result });
      },
    });
    const client = new McpClient({ name: "fixture", version: "1" });
    t.after(async () => {
      release.resolve();
      await client.close();
    });
    await client.connect(transport);
    hold = true;
    const controller = new globalThis.AbortController();
    const pending = client.callTool(
      "must-not-send",
      {},
      { signal: controller.signal, timeoutMs: mode === "timeout" ? 20 : 10000 },
    );
    const rejected = assert.rejects(pending, (error) => /abort|timed out|timeout/i.test(error.message));
    await entered.promise;
    if (mode === "abort") controller.abort();
    await rejected;
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(methods.filter((method) => method === "tools/call").length, 0);
  });
