import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { importTestBundle } from "#test-bundle";
const { McpOAuthStore } = await importTestBundle("mcp-oauth-store", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "oauth-store.ts")],
});

test("Pi 1.0.4 CLI and Desktop isolate accounts at the same URL and adopt a legacy grant only once", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-identity-")),
    store = new McpOAuthStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = path.resolve(import.meta.dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist");
  const { FileAuthStorageBackend } = await import(pathToFileURL(path.join(sdk, "core/auth-storage.js")));
  const { McpOAuthCredentialStore } = await import(pathToFileURL(path.join(sdk, "extensions/mcp/oauth.js")));
  const cli = new McpOAuthCredentialStore(new FileAuthStorageBackend(store.filename), root);
  const url = "https://shared.example.invalid/mcp";
  writeFileSync(
    store.filename,
    JSON.stringify({
      [url]: { serverUrl: url, tokens: { access_token: "LEGACY", token_type: "Bearer" }, future: "keep" },
    }),
  );
  assert.equal((await store.forServer("first-account", url).load()).tokens.access_token, "LEGACY");
  assert.equal((await cli.forServer("first-account", url).load()).future, "keep");
  assert.equal(await cli.forServer("second", url).load(), undefined);
  await cli.forServer("second", url).save({ serverUrl: url, tokens: { access_token: "SECOND", token_type: "Bearer" } });
  assert.equal(await store.authProvider("second", url).token(), "SECOND");
  assert.equal(await store.authProvider("first-account", url).token(), "LEGACY");
  const order = [];
  await Promise.all([
    store.withRefreshLock("first-account", url, async () => {
      order.push("desktop");
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push("desktop-end");
    }),
    cli.forServer("first-account", url).withRefreshLock(async () => {
      order.push("cli");
      order.push("cli-end");
    }),
  ]);
  assert.equal(order.indexOf("desktop-end"), order.indexOf("desktop") + 1);
  assert.equal(order.indexOf("cli-end"), order.indexOf("cli") + 1);
  await store.remove("first-account", url);
  assert.equal(await cli.forServer("first-account", url).load(), undefined);
  assert.equal((await cli.forServer("second", url).load()).tokens.access_token, "SECOND");
});

for (const outcome of ["timeout", "closing"]) {
  test(`native refresh signal ${outcome === "timeout" ? "prevents fallback authorization on timeout" : "lets an already started rotation persist during close"}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-native-signal-"));
    const store = new McpOAuthStore(root),
      base = "http://127.0.0.1:12345",
      url = base + "/mcp";
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await store.forServer("fixture", url).save({
      serverUrl: url,
      discovery: {
        authorizationServerUrl: base,
        authorizationServerMetadata: {
          issuer: base,
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      },
      clientInformation: { client_id: "fixture", redirect_uris: ["http://127.0.0.1/callback"] },
      tokens: { access_token: "OLD", refresh_token: "OLD_REFRESH", token_type: "Bearer" },
      tokensExpireAt: 0,
    });
    const deadline = new globalThis.AbortController(),
      connection = new globalThis.AbortController();
    t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
      assert.equal(ms, 15000);
      return deadline.signal;
    });
    let entered, release, requestSignal;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const fetch = async (input, init) => {
      assert.equal(String(input), base + "/token");
      requestSignal = init.signal;
      entered();
      return new Promise((resolve, reject) => {
        release = () =>
          resolve(
            new globalThis.Response(
              JSON.stringify({ access_token: "NEW", refresh_token: "ROTATED", token_type: "Bearer" }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    };
    const auth = store.authProvider(
      "fixture",
      url,
      {},
      fetch,
      undefined,
      () => !connection.signal.aborted,
      connection.signal,
    );
    const pending = auth.onUnauthorized({
      serverUrl: url,
      token: "OLD",
      fetch,
      response: new globalThis.Response("", { status: 401 }),
    });
    await waiting;
    assert.equal(requestSignal, deadline.signal, "SDK options and HTTP use the same refresh deadline");
    if (outcome === "timeout") {
      deadline.abort(new globalThis.DOMException("refresh timed out", "TimeoutError"));
      await assert.rejects(pending, /timed out/);
      const saved = await store.forServer("fixture", url).load();
      assert.equal(saved.tokens.refresh_token, "OLD_REFRESH");
      assert.equal(saved.codeVerifier, undefined, "a timeout must not start a new authorization");
    } else {
      connection.abort();
      assert.equal(requestSignal.aborted, false, "closing cannot discard a started token rotation");
      release();
      await pending;
      await auth.settled();
      assert.equal((await store.forServer("fixture", url).load()).tokens.refresh_token, "ROTATED");
      await assert.rejects(auth.token());
    }
  });
}

test("refresh-lock cancellation does not enter the credential mutation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-refresh-cancel-")),
    store = new McpOAuthStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const url = "https://example.invalid/mcp",
    controller = new globalThis.AbortController();
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = store.withRefreshLock("fixture", url, async () => {
    entered();
    await gate;
  });
  await ready;
  let mutated = false;
  const second = store.withRefreshLock(
    "fixture",
    url,
    async () => {
      mutated = true;
    },
    controller.signal,
  );
  controller.abort();
  try {
    await assert.rejects(second, /abort/i);
    assert.equal(mutated, false);
  } finally {
    release();
    await first;
  }
});

test("a stale provider state cannot overwrite another CLI flow or resurrect a signed-out slot", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-stale-state-")),
    store = new McpOAuthStore(root),
    url = "https://example.invalid/mcp";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = store.forServer("fixture", url);
  await first.save({ serverUrl: url, oauthState: "first" });
  const snapshot = await first.load();
  await store.forServer("fixture", url).save({ serverUrl: url, oauthState: "replacement" });
  await assert.rejects(
    first.save({ ...snapshot, discovery: { authorizationServerUrl: "https://auth.invalid" } }),
    /state changed/,
  );
  await assert.rejects(
    store.commitAuthorization(
      "fixture",
      url,
      { access_token: "STALE", token_type: "Bearer" },
      "first",
      new globalThis.AbortController().signal,
    ),
    /replaced or signed out/,
  );
  await store.remove("fixture", url);
  await assert.rejects(
    first.save({ ...snapshot, tokens: { access_token: "STALE", token_type: "Bearer" } }),
    /state changed/,
  );
  assert.equal(await store.forServer("fixture", url).load(), undefined);
});

test("late challenges cannot cross logout or retired connections and concurrent scopes are retained", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-late-challenge-")),
    store = new McpOAuthStore(root),
    url = "https://example.invalid/mcp";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { url, oauth: { clientId: "fixture" } };
  const { createHash } = await import("node:crypto");
  const configuration = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  let current = true;
  const auth = store.authProvider("fixture", url, config.oauth, undefined, configuration, () => current);
  const challenge = (scope) =>
    auth.onUnauthorized({
      serverUrl: url,
      token: undefined,
      fetch: globalThis.fetch,
      response: new globalThis.Response("", {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="' + scope + '"' },
      }),
    });
  await assert.rejects(challenge("read"));
  await assert.rejects(challenge("write"));
  assert.equal(store.challenge("fixture", config).scope, "read write");
  current = false;
  await assert.rejects(challenge("retired"));
  assert.equal(store.challenge("fixture", config).scope, "read write");
  current = true;
  await store.remove("fixture", url);
  await assert.rejects(challenge("after-logout"));
  assert.equal(store.challenge("fixture", config), undefined);
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
  const firstKey = "mcp__first|" + first;
  const scoped = store.forServer("first", first),
    state = await scoped.load();
  assert.equal(state.tokens.access_token, "CLI_TOKEN");
  assert.equal(await store.authProvider("first", first).token(), "CLI_TOKEN");
  const provider = store.provider("first", first);
  await provider.saveTokens({ access_token: "UPDATED", token_type: "Bearer", expires_in: 3600 });
  const updated = JSON.parse(readFileSync(store.filename, "utf8"));
  assert.equal(updated[firstKey].future, true);
  assert.ok(updated[firstKey].tokensExpireAt > Date.now());
  assert.equal(updated[other].tokens.access_token, "OTHER_TOKEN");
  await assert.rejects(scoped.save({ serverUrl: other }), /another server/);
  await store.remove("first", first);
  assert.equal(JSON.parse(readFileSync(store.filename, "utf8"))[firstKey], undefined);
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
      .forServer("fixture", serverUrl, controller.signal)
      .save({ serverUrl, tokens: { access_token: "CANCELLED", token_type: "Bearer" } }),
  );
  const order = [];
  await Promise.all([
    store.withRefreshLock("fixture", serverUrl, async () => {
      order.push("first");
      await store.forServer("fixture", serverUrl).save({ serverUrl });
      order.push("first-end");
    }),
    store.withRefreshLock("fixture", serverUrl, async () => {
      order.push("second");
      order.push("second-end");
    }),
  ]);
  assert.deepEqual(order.length, 4);
  assert.equal(order.indexOf("first-end"), order.indexOf("first") + 1);
  assert.equal(order.indexOf("second-end"), order.indexOf("second") + 1);
  assert.doesNotMatch(readFileSync(store.filename, "utf8"), /CANCELLED/);
});
