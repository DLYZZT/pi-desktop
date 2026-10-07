import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { McpConnection, McpOAuthStore } = await importTestBundle("mcp-provider-auth", {
  packages: "external",
  stdin: {
    contents: 'export {McpConnection} from "./connection.ts"; export {McpOAuthStore} from "./oauth-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("provider-auth MCP reads the current provider token for every request without storing an MCP credential", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-provider-auth-"));
  const credentials = new McpOAuthStore(root),
    toolHeaders = [];
  let token = "FIRST_FIXTURE_TOKEN",
    resolutions = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) return response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "ok" }] };
    if (message.method === "tools/call") toolHeaders.push(request.headers.authorization);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    url: "http://127.0.0.1:" + server.address().port + "/mcp",
    auth: { provider: "fixture-provider" },
    headers: { Authorization: "IGNORED_STATIC_FIXTURE" },
  };
  const snapshot = {
    name: "fixture",
    sessionId: "fixture",
    cwd: root,
    source: "fixture",
    scope: "global",
    revision: "one",
    generation: 1,
    state: "not-started",
    observedAt: 0,
    toolCount: 0,
  };
  const providerToken = async (provider) => {
    assert.equal(provider, "fixture-provider");
    resolutions++;
    return token;
  };
  const connection = new McpConnection({ config, snapshot, credentials, providerToken, trusted: true, changed() {} });
  t.after(async () => {
    await connection.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await connection.start();
  await connection.client.callTool("echo", {});
  token = "SECOND_FIXTURE_TOKEN";
  await connection.client.callTool("echo", {});
  assert.deepEqual(toolHeaders, ["Bearer FIRST_FIXTURE_TOKEN", "Bearer SECOND_FIXTURE_TOKEN"]);
  assert.ok(resolutions >= 4);
  assert.equal(existsSync(credentials.filename), false);
  assert.doesNotMatch(JSON.stringify(connection.snapshot), /FIRST_FIXTURE_TOKEN|SECOND_FIXTURE_TOKEN/);
  const before = resolutions;
  assert.throws(
    () =>
      new McpConnection({
        config,
        snapshot: { ...snapshot, scope: "project" },
        credentials,
        providerToken,
        trusted: true,
        changed() {},
      }),
    /only allowed in global/,
  );
  assert.equal(resolutions, before);
  token = undefined;
  await assert.rejects(connection.client.callTool("echo", {}), /Sign in to fixture-provider/);
  assert.equal(connection.snapshot.state, "needs-auth");
  assert.equal(toolHeaders.length, 2);
});
