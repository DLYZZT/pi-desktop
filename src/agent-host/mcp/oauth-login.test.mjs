import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpOAuthLoginManager, McpOAuthStore } = await importTestBundle("mcp-oauth-login", {
  packages: "external",
  stdin: {
    contents: 'export {McpOAuthLoginManager} from "./oauth-login.ts"; export {McpOAuthStore} from "./oauth-store.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-signin-")),
    store = new McpOAuthStore(root),
    base = "http://127.0.0.1:12345";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshots = [];
  let openedResolve;
  const opened = new Promise((resolve) => {
    openedResolve = resolve;
  });
  const manager = new McpOAuthLoginManager(store, {
    updated: (snapshot) => snapshots.push(snapshot),
    openUrl: async (url) => {
      openedResolve(url);
    },
    fetch: async (input) => {
      const url = String(input);
      let value;
      if (url.includes("oauth-protected-resource"))
        value = { resource: base + "/mcp", authorization_servers: [base], scopes_supported: ["read"] };
      else if (url.includes("oauth-authorization-server") || url.includes("openid-configuration"))
        value = {
          issuer: base,
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        };
      else if (url.endsWith("/token"))
        value = {
          access_token: "PRIVATE_MCP_TOKEN",
          token_type: "Bearer",
          refresh_token: "PRIVATE_REFRESH",
          expires_in: 3600,
        };
      else return new globalThis.Response("missing", { status: 404 });
      return new globalThis.Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    },
  });
  const start = () =>
    manager.start({
      name: "fixture",
      sessionId: "session",
      cwd: root,
      trusted: true,
      config: { url: base + "/mcp", oauth: { clientId: "fixture-client" } },
    });
  return { store, manager, start, opened, snapshots, base };
}

test("MCP sign-in accepts a matching pasted callback, keeps credentials private and closes the loopback listener", async (t) => {
  const f = fixture(t),
    request = f.start();
  const authUrl = new URL(await f.opened),
    callback = new URL(authUrl.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", "wrong");
  callback.searchParams.set("code", "fixture-code");
  await assert.rejects(f.manager.submit(request.requestId, callback.href), (error) => error.code === "BAD_REQUEST");
  callback.searchParams.set("state", authUrl.searchParams.get("state"));
  const done = await f.manager.submit(request.requestId, callback.href);
  assert.equal(done.state, "succeeded");
  assert.equal((await f.store.forServer(f.base + "/mcp").load()).tokens.access_token, "PRIVATE_MCP_TOKEN");
  assert.doesNotMatch(JSON.stringify(f.snapshots), /PRIVATE_MCP_TOKEN|PRIVATE_REFRESH|codeVerifier/);
  await assert.rejects(globalThis.fetch(callback.href));
});

test("cancelling MCP sign-in closes the listener and does not save tokens", async (t) => {
  const f = fixture(t),
    request = f.start(),
    authUrl = new URL(await f.opened);
  const callback = authUrl.searchParams.get("redirect_uri");
  const cancelled = await f.manager.cancel(request.requestId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await f.store.forServer(f.base + "/mcp").load())?.tokens, undefined);
  await assert.rejects(globalThis.fetch(callback));
});

test("Host shutdown cancels settings-only MCP authorization and closes its callback listener", async (t) => {
  const f = fixture(t),
    request = f.start(),
    authUrl = new URL(await f.opened);
  await f.manager.shutdown();
  assert.equal(f.manager.get(request.requestId).state, "cancelled");
  await assert.rejects(globalThis.fetch(authUrl.searchParams.get("redirect_uri")));
  assert.equal((await f.store.forServer(f.base + "/mcp").load())?.tokens, undefined);
});
