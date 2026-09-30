import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { importTestBundle } from "#test-bundle";
const { McpConnection } = await importTestBundle("mcp-connection", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "connection.ts")],
});

function connection(createTransport, changed = () => {}) {
  return new McpConnection({
    snapshot: {
      name: "fixture",
      sessionId: "session",
      cwd: process.cwd(),
      source: "fixture",
      scope: "global",
      generation: 1,
      revision: "one",
      state: "not-started",
      toolCount: 0,
      observedAt: 0,
    },
    config: { command: "fixture", timeout: 1 },
    trusted: true,
    changed,
    createTransport,
  });
}

test("MCP connections initialize and refresh tool catalogs after list-change notifications", async (t) => {
  const { client: clientSide, server: serverSide } = createInMemoryTransportPair();
  let name = "first";
  serverSide.onMessage((request) => {
    if (request.id === undefined) return;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools: [{ name, inputSchema: { type: "object" } }] };
    void serverSide.send({ jsonrpc: "2.0", id: request.id, result });
  });
  await serverSide.start();
  let changedResolve;
  const updated = new Promise((resolve) => {
    changedResolve = resolve;
  });
  const current = connection(
    () => clientSide,
    (value) => {
      if (value.tools[0]?.name === "second") changedResolve();
    },
  );
  t.after(() => current.close());
  await current.start();
  assert.equal(current.snapshot.state, "connected");
  assert.equal(current.tools[0].name, "first");
  name = "second";
  await serverSide.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await updated;
  assert.equal(current.tools[0].name, "second");
  await current.close();
  assert.equal(current.snapshot.state, "disconnected");
  assert.equal(current.tools.length, 0);
});

test("authentication failures stay needs-auth rather than being overwritten by close notifications", async () => {
  const current = connection(() => {
    throw new McpOAuthAuthorizationRequiredError();
  });
  await assert.rejects(current.start(), McpOAuthAuthorizationRequiredError);
  assert.equal(current.snapshot.state, "needs-auth");
  await current.close();
});
