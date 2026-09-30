import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpOAuthStore } = await importTestBundle("mcp-oauth-store", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "oauth-store.ts")],
});

test("MCP OAuth storage reads CLI states, preserves other URLs, and refuses cross-server saves", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-oauth-")),
    store = new McpOAuthStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = "https://example.invalid/mcp",
    other = "https://other.invalid/mcp";
  writeFileSync(
    store.filename,
    JSON.stringify({
      [first]: { serverUrl: first, tokens: { access_token: "CLI_TOKEN", token_type: "Bearer" }, future: true },
      [other]: { serverUrl: other, tokens: { access_token: "OTHER_TOKEN", token_type: "Bearer" } },
    }),
  );
  const scoped = store.forServer(first),
    state = await scoped.load();
  assert.equal(state.tokens.access_token, "CLI_TOKEN");
  assert.equal(await store.authProvider(first).token(), "CLI_TOKEN");
  const provider = store.provider(first);
  await provider.saveTokens({ access_token: "UPDATED", token_type: "Bearer", expires_in: 3600 });
  const updated = JSON.parse(readFileSync(store.filename, "utf8"));
  assert.equal(updated[first].future, true);
  assert.ok(updated[first].tokensExpireAt > Date.now());
  assert.equal(updated[other].tokens.access_token, "OTHER_TOKEN");
  await assert.rejects(scoped.save({ serverUrl: other }), /another server/);
  await store.remove(first);
  assert.equal(JSON.parse(readFileSync(store.filename, "utf8"))[first], undefined);
  assert.equal(JSON.parse(readFileSync(store.filename, "utf8"))[other].tokens.access_token, "OTHER_TOKEN");
});

test("MCP OAuth saves are serialized with CLI-compatible refresh lock names and cancellation never commits", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-oauth-lock-")),
    store = new McpOAuthStore(path.join(root, "agent"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(store.filename));
  const serverUrl = "https://example.invalid/mcp",
    controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    store
      .forServer(serverUrl, controller.signal)
      .save({ serverUrl, tokens: { access_token: "CANCELLED", token_type: "Bearer" } }),
  );
  const order = [];
  await Promise.all([
    store.withRefreshLock(serverUrl, async () => {
      order.push("first");
      await store.forServer(serverUrl).save({ serverUrl });
      order.push("first-end");
    }),
    store.withRefreshLock(serverUrl, async () => {
      order.push("second");
      order.push("second-end");
    }),
  ]);
  assert.deepEqual(order.length, 4);
  assert.equal(order.indexOf("first-end"), order.indexOf("first") + 1);
  assert.equal(order.indexOf("second-end"), order.indexOf("second") + 1);
  assert.doesNotMatch(readFileSync(store.filename, "utf8"), /CANCELLED/);
});
