import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
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

test("authorization replaces its grant without overwriting newer unrelated shared-state fields", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-commit-fields-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new McpOAuthStore(root),
    url = "https://fixture.invalid/mcp";
  await store.forServer("fixture", url).save({
    serverUrl: url,
    oauthState: "flow",
    future: "updated-by-cli",
    clientInformation: { client_id: "old-client" },
    tokens: { access_token: "old-token", token_type: "Bearer" },
    tokensExpireAt: 1,
    codeVerifier: "old-verifier",
  });
  await store.commitAuthorization(
    "fixture",
    url,
    { access_token: "new-token", token_type: "Bearer" },
    "flow",
    new globalThis.AbortController().signal,
    {
      serverUrl: url,
      oauthState: "flow",
      future: "stale-snapshot",
      codeVerifier: "new-verifier",
    },
  );
  const saved = await store.forServer("fixture", url).load();
  assert.equal(saved.future, "updated-by-cli");
  assert.equal(saved.clientInformation, undefined);
  assert.equal(saved.tokensExpireAt, undefined);
  assert.equal(saved.codeVerifier, "new-verifier");
  assert.equal(saved.tokens.access_token, "new-token");
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

function refreshFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-refresh-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new McpOAuthStore(root),
    base = "https://oauth.fixture.invalid",
    url = base + "/mcp";
  const state = {
    serverUrl: url,
    clientInformation: { client_id: "original-client", redirect_uris: ["http://127.0.0.1/callback"] },
    tokens: { access_token: "OLD", refresh_token: "OLD_REFRESH", token_type: "Bearer", scope: "read" },
    tokensExpireAt: 0,
    oauthState: "interactive-flow",
    codeVerifier: "interactive-verifier",
    future: "keep",
    discovery: {
      authorizationServerUrl: base,
      authorizationServerMetadata: {
        issuer: base,
        authorization_endpoint: base + "/authorize",
        registration_endpoint: base + "/register",
        token_endpoint: base + "/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: { resource: url },
    },
  };
  const unauthorized = (auth, fetch) =>
    auth.onUnauthorized({
      serverUrl: url,
      token: "OLD",
      fetch,
      response: new globalThis.Response("", { status: 401 }),
    });
  return { root, store, base, url, state, unauthorized };
}

for (const failure of ["network", "server_error"]) {
  test(`refresh ${failure} preserves the grant and cannot start background authorization`, async (t) => {
    const f = refreshFixture(t);
    await f.store.forServer("fixture", f.url).save(f.state);
    const before = readFileSync(f.store.filename, "utf8");
    const requests = [];
    const fetch = async (input, init) => {
      requests.push(String(input));
      assert.equal(String(input), f.base + "/token");
      assert.equal(new globalThis.URLSearchParams(init.body).get("grant_type"), "refresh_token");
      if (failure === "network") throw new TypeError("fixture network failure");
      return globalThis.Response.json({ error: "server_error" }, { status: 503 });
    };
    const auth = f.store.authProvider("fixture", f.url, {}, fetch);
    await assert.rejects(
      f.unauthorized(auth, fetch),
      failure === "network" ? /fixture network failure/ : /server_error/,
    );
    assert.deepEqual(requests, [f.base + "/token"]);
    assert.equal(readFileSync(f.store.filename, "utf8"), before);
  });
}

for (const error of ["invalid_client", "unauthorized_client", "invalid_grant"]) {
  test(`a retired connection's ${error} response cannot invalidate the shared grant`, async (t) => {
    const f = refreshFixture(t);
    await f.store.forServer("fixture", f.url).save(f.state);
    const before = readFileSync(f.store.filename, "utf8");
    const connection = new globalThis.AbortController();
    const fetch = async (input, init) => {
      assert.equal(String(input), f.base + "/token");
      connection.abort();
      assert.equal(init.signal.aborted, false, "the in-flight request keeps its independent deadline");
      return globalThis.Response.json({ error }, { status: 400 });
    };
    const auth = f.store.authProvider(
      "fixture",
      f.url,
      {},
      fetch,
      undefined,
      () => !connection.signal.aborted,
      connection.signal,
    );
    await assert.rejects(f.unauthorized(auth, fetch), McpOAuthAuthorizationRequiredError);
    assert.equal(readFileSync(f.store.filename, "utf8"), before);
  });
}

for (const outcome of ["success", "invalid_client", "invalid_grant"]) {
  for (const external of ["sign-in", "logout"]) {
    test(`late refresh ${outcome} cannot overwrite CLI ${external}`, async (t) => {
      const f = refreshFixture(t);
      await f.store.forServer("fixture", f.url).save(f.state);
      const sdk = path.resolve(import.meta.dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist");
      const { FileAuthStorageBackend } = await import(pathToFileURL(path.join(sdk, "core/auth-storage.js")));
      const { McpOAuthCredentialStore } = await import(pathToFileURL(path.join(sdk, "extensions/mcp/oauth.js")));
      const cli = new McpOAuthCredentialStore(new FileAuthStorageBackend(f.store.filename), f.root);
      let entered, release;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const fetch = async (input) => {
        assert.equal(String(input), f.base + "/token");
        entered();
        await gate;
        return outcome === "success"
          ? globalThis.Response.json({
              access_token: "STALE_RESULT",
              refresh_token: "STALE_ROTATION",
              token_type: "Bearer",
            })
          : globalThis.Response.json({ error: outcome }, { status: 400 });
      };
      const auth = f.store.authProvider("fixture", f.url, {}, fetch);
      const pending = f.unauthorized(auth, fetch);
      const finished = external === "logout" ? assert.rejects(pending, McpOAuthAuthorizationRequiredError) : pending;
      await started;
      const replacement = {
        ...f.state,
        clientInformation: { client_id: "replacement-client" },
        tokens: { access_token: "REPLACEMENT", refresh_token: "REPLACEMENT_REFRESH", token_type: "Bearer" },
        tokensExpireAt: Date.now() + 3600000,
        oauthState: "replacement-flow",
      };
      try {
        if (external === "logout") cli.remove("fixture", f.url);
        else await cli.forServer("fixture", f.url).save(replacement);
      } finally {
        release();
      }
      await finished;
      assert.deepEqual(await cli.forServer("fixture", f.url).load(), external === "logout" ? undefined : replacement);
    });
  }
}

test("successful refresh updates only its grant while a CLI login changes flow metadata", async (t) => {
  const f = refreshFixture(t);
  await f.store.forServer("fixture", f.url).save(f.state);
  const fetch = async (input) => {
    assert.equal(String(input), f.base + "/token");
    // Independent writer, as with a CLI login that reserves a new nonce while the token rotates.
    await new McpOAuthStore(f.root).forServer("fixture", f.url).save({
      ...f.state,
      oauthState: "new-interactive-flow",
      codeVerifier: "new-verifier",
      future: "new-value",
    });
    return globalThis.Response.json({ access_token: "ROTATED", token_type: "Bearer", expires_in: 3600 });
  };
  await f.unauthorized(f.store.authProvider("fixture", f.url, {}, fetch), fetch);
  const saved = await f.store.forServer("fixture", f.url).load();
  assert.equal(saved.oauthState, "new-interactive-flow");
  assert.equal(saved.codeVerifier, "new-verifier");
  assert.equal(saved.future, "new-value");
  assert.equal(saved.tokens.access_token, "ROTATED");
  assert.equal(saved.tokens.refresh_token, "OLD_REFRESH");
  assert.equal(saved.tokens.scope, "read");
  assert.ok(saved.tokensExpireAt > Date.now());
});

test("refresh honors configured metadata and client authentication without replacing the discovery cache", async (t) => {
  const f = refreshFixture(t);
  delete f.state.clientInformation;
  await f.store.forServer("fixture", f.url).save(f.state);
  const metadataUrl = "https://configured.fixture.invalid/metadata",
    tokenUrl = "https://configured.fixture.invalid/token";
  const urls = [];
  const fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("oauth-protected-resource"))
      return globalThis.Response.json({ resource: f.url, authorization_servers: [f.base] });
    if (url === metadataUrl)
      return globalThis.Response.json({
        ...f.state.discovery.authorizationServerMetadata,
        issuer: "https://configured.fixture.invalid",
        token_endpoint: tokenUrl,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    assert.equal(url, tokenUrl);
    const body = new globalThis.URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("client_id"), "static-client");
    assert.equal(body.get("client_secret"), "fixture-secret");
    assert.equal(body.get("resource"), f.url);
    return globalThis.Response.json({ access_token: "NEW", token_type: "Bearer" });
  };
  const auth = f.store.authProvider(
    "fixture",
    f.url,
    { clientId: "static-client", clientSecret: "fixture-secret", authServerMetadataUrl: metadataUrl },
    fetch,
  );
  await f.unauthorized(auth, fetch);
  assert.ok(urls.includes(metadataUrl));
  assert.ok(!urls.includes(f.base + "/token"));
  const saved = await f.store.forServer("fixture", f.url).load();
  assert.deepEqual(saved.discovery, f.state.discovery);
  assert.equal(saved.tokens.scope, "read");
  assert.equal(saved.tokens.refresh_token, "OLD_REFRESH");
  assert.equal(saved.tokensExpireAt, undefined);
});

test("refresh rejects an insecure configured metadata URL before making requests", async (t) => {
  const f = refreshFixture(t);
  await f.store.forServer("fixture", f.url).save(f.state);
  let requests = 0;
  const fetch = async () => {
    requests++;
    throw new Error("unexpected request");
  };
  const auth = f.store.authProvider(
    "fixture",
    f.url,
    { authServerMetadataUrl: "http://remote.fixture.invalid/metadata" },
    fetch,
  );
  await assert.rejects(f.unauthorized(auth, fetch), /https|insecure/i);
  assert.equal(requests, 0);
  assert.equal((await f.store.forServer("fixture", f.url).load()).oauthState, f.state.oauthState);
});
