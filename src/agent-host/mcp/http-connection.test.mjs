import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpConnection, McpOAuthStore } = await importTestBundle("mcp-http", {
  packages: "external",
  stdin: {
    contents: 'export {McpConnection} from "./connection.ts"; export {McpOAuthStore} from "./oauth-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

test("real Streamable HTTP MCP initializes, reads resources and shares one rotating-token refresh", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-http-")),
    credentials = new McpOAuthStore(root);
  let base,
    refreshes = 0,
    calls = 0;
  const server = createServer(async (request, response) => {
    const json = (value) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.url.includes("oauth-protected-resource"))
      return json({ resource: base + "/mcp", authorization_servers: [base] });
    if (request.url.includes("oauth-authorization-server") || request.url.includes("openid-configuration"))
      return json({
        issuer: base,
        authorization_endpoint: base + "/authorize",
        token_endpoint: base + "/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (request.url === "/token") {
      refreshes++;
      return json({ access_token: "NEW_TOKEN", token_type: "Bearer", refresh_token: "ROTATED", expires_in: 3600 });
    }
    if (request.method !== "POST") return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.headers.authorization, "Bearer NEW_TOKEN");
    if (message.id === undefined) return response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "http-fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : message.method === "resources/list"
            ? { resources: [{ uri: "fixture://ordinary", name: "Ordinary", mimeType: "text/plain" }] }
            : message.method === "resources/read"
              ? { contents: [{ uri: message.params.uri, text: "RAW_RESOURCE_原始", mimeType: "text/plain" }] }
              : { content: [{ type: "text", text: "HTTP_ORIGINAL_" + message.params.arguments.text }] };
    if (message.method === "tools/call") calls++;
    json({ jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const url = base + "/mcp";
  await credentials.forServer("fixture", url).save({
    serverUrl: url,
    clientInformation: { client_id: "fixture", redirect_uris: ["http://127.0.0.1/callback"] },
    tokens: { access_token: "OLD_TOKEN", refresh_token: "OLD_REFRESH", token_type: "Bearer" },
    tokensExpireAt: 0,
  });
  const make = (id) =>
    new McpConnection({
      config: { url, timeout: 2 },
      credentials,
      trusted: true,
      changed() {},
      snapshot: {
        name: "fixture",
        sessionId: id,
        cwd: root,
        source: "fixture",
        scope: "global",
        revision: "one",
        generation: 1,
        state: "not-started",
        observedAt: 0,
        toolCount: 0,
      },
    });
  const first = make("first"),
    second = make("second");
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([first.start(), second.start()]);
  assert.equal(refreshes, 1);
  assert.equal(first.snapshot.state, "connected");
  const results = await Promise.all([
    first.client.callTool("echo", { text: "one" }),
    second.client.callTool("echo", { text: "two" }),
  ]);
  assert.equal(calls, 2);
  assert.equal(results[0].content[0].text, "HTTP_ORIGINAL_one");
  assert.equal((await first.client.listResourcesPage()).resources[0].uri, "fixture://ordinary");
  assert.equal((await second.client.readResource("fixture://ordinary")).contents[0].text, "RAW_RESOURCE_原始");
  assert.equal((await credentials.forServer("fixture", url).load()).tokens.refresh_token, "ROTATED");
});
