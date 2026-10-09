import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpOAuthLoginManager, McpOAuthStore, McpService } = await importTestBundle("mcp-oauth-login", {
  packages: "external",
  stdin: {
    contents:
      'export {McpOAuthLoginManager} from "./oauth-login.ts"; export {McpOAuthStore} from "./oauth-store.ts"; export {McpService} from "./service.ts";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
});

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-signin-")),
    store = new McpOAuthStore(root),
    base = "http://127.0.0.1:12345";

  const snapshots = [],
    requests = [];
  let openedResolve;
  const opened = new Promise((resolve) => {
    openedResolve = resolve;
  });
  const loginOptions = {
    validate: options.validate,
    updated: (snapshot) => snapshots.push(snapshot),
    openUrl: async (url) => {
      openedResolve(url);
    },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method, body: init?.body ? String(init.body) : undefined });
      let value;
      if (url.includes("oauth-protected-resource"))
        value = { resource: base + "/mcp", authorization_servers: [base], scopes_supported: ["read"] };
      else if (
        url.includes("oauth-authorization-server") ||
        url.includes("openid-configuration") ||
        url.endsWith("/forced-metadata")
      )
        value = {
          issuer: base,
          authorization_response_iss_parameter_supported: options.issuerRequired ?? false,
          client_id_metadata_document_supported: options.cimd ?? false,
          registration_endpoint: options.cimd ? undefined : base + "/register",
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        };
      else if (url.endsWith("/register")) {
        const metadata = JSON.parse(String(init?.body));
        value = {
          client_id: "registered-client",
          redirect_uris: metadata.redirect_uris,
          client_name: metadata.client_name,
        };
      } else if (url.endsWith("/token")) {
        await options.onToken?.(init);
        value = {
          access_token: "PRIVATE_MCP_TOKEN",
          token_type: "Bearer",
          refresh_token: "PRIVATE_REFRESH",
          expires_in: 3600,
        };
      } else return new globalThis.Response("missing", { status: 404 });
      return new globalThis.Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    },
  };
  const manager = new McpOAuthLoginManager(store, loginOptions);
  t.after(async () => {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const config = { url: base + "/mcp", oauth: options.oauth ?? { clientId: "fixture-client" } };
  const input = { name: "fixture", sessionId: "session", cwd: root, trusted: true, config };
  const start = (patch = {}) => manager.start({ ...input, ...patch });
  return { store, manager, start, opened, snapshots, base, requests, config, input, root, loginOptions };
}

for (const phase of ["discovery", "registration"]) {
  test(`native OAuth signal cancels ${phase} before credentials or a browser redirect are issued`, async (t) => {
    const f = fixture(t, { oauth: {} });
    const fetch = f.loginOptions.fetch;
    let entered, receivedSignal;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    f.loginOptions.fetch = (input, init) => {
      if (phase === "discovery" || String(input).endsWith("/register")) {
        receivedSignal = init.signal;
        entered();
        return new Promise((_resolve, reject) => {
          const abort = () => reject(init.signal.reason);
          if (init.signal.aborted) abort();
          else init.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return fetch(input, init);
    };
    const request = f.start();
    await waiting;
    const result = await f.manager.cancel(request.requestId);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(result.state, "cancelled");
    assert.equal((await f.store.forServer("fixture", f.config.url).load())?.tokens, undefined);
    assert.ok(f.snapshots.every((snapshot) => !snapshot.authUrl));
  });
}

test("OAuth discovery deadline fails the network phase without misreporting a user cancellation", async (t) => {
  const deadline = new globalThis.AbortController();
  t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 15000);
    return deadline.signal;
  });
  const f = fixture(t);
  let entered, completed;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const finished = new Promise((resolve) => {
    completed = resolve;
  });
  f.loginOptions.updated = (snapshot) => {
    if (snapshot.state !== "waiting") completed(snapshot);
  };
  f.loginOptions.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      entered();
    });
  f.start();
  await waiting;
  deadline.abort(new globalThis.DOMException("OAuth phase timed out", "TimeoutError"));
  const result = await finished;
  assert.equal(result.state, "failed");
  assert.match(result.error, /timed out/);
  assert.equal((await f.store.forServer("fixture", f.config.url).load())?.tokens, undefined);
});

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
  assert.equal((await f.store.forServer("fixture", f.base + "/mcp").load()).tokens.access_token, "PRIVATE_MCP_TOKEN");
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
  assert.equal((await f.store.forServer("fixture", f.base + "/mcp").load())?.tokens, undefined);
  await assert.rejects(globalThis.fetch(callback));
});

test("Host shutdown cancels settings-only MCP authorization and closes its callback listener", async (t) => {
  const f = fixture(t),
    request = f.start(),
    authUrl = new URL(await f.opened);
  await f.manager.shutdown();
  assert.equal(f.manager.get(request.requestId).state, "cancelled");
  await assert.rejects(globalThis.fetch(authUrl.searchParams.get("redirect_uri")));
  assert.equal((await f.store.forServer("fixture", f.base + "/mcp").load())?.tokens, undefined);
});

test("a header-authenticated server cannot create an unused OAuth grant", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.start({ config: { ...f.config, headers: { aUtHoRiZaTiOn: "PRIVATE_FIXTURE" } } }),
    /Authorization header/,
  );
  assert.equal(f.requests.length, 0);
});

function callbackUrl(authUrl, issuer) {
  const url = new URL(authUrl),
    callback = new URL(url.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", url.searchParams.get("state"));
  callback.searchParams.set("code", "fixture-code");
  if (issuer !== undefined) callback.searchParams.set("iss", issuer);
  return callback;
}

for (const issuer of ["correct", "wrong", "missing"]) {
  test(`RFC 9207 ${issuer} issuer is checked by the actual token exchange`, async (t) => {
    const f = fixture(t, { issuerRequired: true }),
      request = f.start();
    const callback = callbackUrl(
      await f.opened,
      issuer === "correct" ? f.base : issuer === "wrong" ? "https://wrong.invalid" : undefined,
    );
    const result = await f.manager.submit(request.requestId, callback.href);
    assert.equal(result.state, issuer === "correct" ? "succeeded" : "failed");
    assert.equal(f.requests.filter((entry) => entry.url.endsWith("/token")).length, issuer === "correct" ? 1 : 0);
  });
}

test("configured authorization metadata works with required iss without relying on cached discovery", async (t) => {
  const f = fixture(t, {
    issuerRequired: true,
    oauth: { clientId: "fixture-client", authServerMetadataUrl: "http://127.0.0.1:12345/forced-metadata" },
  });
  const request = f.start(),
    callback = callbackUrl(await f.opened, f.base);
  assert.equal((await f.manager.submit(request.requestId, callback.href)).state, "succeeded");
  assert.equal(f.requests.filter((entry) => entry.url.endsWith("/forced-metadata")).length, 2);
  assert.equal((await f.store.forServer("fixture", f.config.url).load()).discovery, undefined);
});

test("custom client name and native application type reach dynamic registration", async (t) => {
  const f = fixture(t, { oauth: { clientName: "Allowed desktop client" } });
  const request = f.start(),
    callback = callbackUrl(await f.opened);
  assert.equal((await f.manager.submit(request.requestId, callback.href)).state, "succeeded");
  const body = JSON.parse(f.requests.find((entry) => entry.url.endsWith("/register")).body);
  assert.equal(body.client_name, "Allowed desktop client");
  assert.equal(body.application_type, "native");
  assert.equal(body.redirect_uris[0], callback.origin + callback.pathname);
});

for (const required of [false, true]) {
  test(`CIMD ${required ? "issuer-bound" : "server-path-bound"} flow never dynamically registers`, async (t) => {
    const f = fixture(t, { cimd: true, issuerRequired: required, oauth: { clientRegistration: "cimd" } });
    const request = f.start(),
      auth = new URL(await f.opened),
      callback = callbackUrl(auth, required ? f.base : undefined);
    if (required) {
      assert.equal(auth.searchParams.get("client_id"), "https://pi.dev/oauth/client.json");
      assert.equal(callback.pathname, "/callback");
    } else {
      assert.match(callback.pathname, /^\/callback\/[A-Za-z0-9_-]{12}$/);
      assert.equal(
        auth.searchParams.get("client_id"),
        "https://pi.dev/oauth/" + callback.pathname.split("/").at(-1) + "/client.json",
      );
      const wrong = new URL(callback);
      wrong.pathname = "/callback";
      await assert.rejects(f.manager.submit(request.requestId, wrong.href), (error) => error.code === "BAD_REQUEST");
    }
    assert.equal((await f.manager.submit(request.requestId, callback.href)).state, "succeeded");
    assert.equal(
      f.requests.some((entry) => entry.url.endsWith("/register")),
      false,
    );
    assert.equal((await f.store.forServer("fixture", f.config.url).load()).clientInformation, undefined);
  });
}

test("loopback callbacks forward iss through the same validated exchange as pasted callbacks", async (t) => {
  const f = fixture(t, { issuerRequired: true }),
    request = f.start(),
    callback = callbackUrl(await f.opened, f.base);
  const response = await globalThis.fetch(callback);
  assert.equal(response.status, 200);
  const deadline = Date.now() + 3000;
  while (f.manager.get(request.requestId).state === "waiting" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.manager.get(request.requestId).state, "succeeded");
});

test("step-up sign-in keeps configured, previously granted and challenged scopes", async (t) => {
  const f = fixture(t, { oauth: { clientId: "fixture-client", scope: "profile" } });
  await f.store
    .forServer("fixture", f.config.url)
    .save({ serverUrl: f.config.url, tokens: { access_token: "OLD", token_type: "Bearer", scope: "read" } });
  const { createHash } = await import("node:crypto");
  const configuration = createHash("sha256").update(JSON.stringify(f.config)).digest("hex");
  const auth = f.store.authProvider("fixture", f.config.url, f.config.oauth, undefined, configuration);
  await assert.rejects(
    auth.onUnauthorized({
      serverUrl: f.config.url,
      token: "OLD",
      fetch: globalThis.fetch,
      response: new globalThis.Response("", {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' },
      }),
    }),
  );
  const request = f.start(),
    url = new URL(await f.opened);
  assert.deepEqual(new Set(url.searchParams.get("scope").split(" ")), new Set(["profile", "read", "write"]));
  assert.equal((await f.manager.submit(request.requestId, callbackUrl(url).href)).state, "succeeded");
  assert.deepEqual(
    new Set((await f.store.forServer("fixture", f.config.url).load()).tokens.scope.split(" ")),
    new Set(["profile", "read", "write"]),
  );
  assert.equal(f.store.challenge("fixture", f.config), undefined);
});

test("one identity cannot have overlapping settings and session sign-ins and every new login gets a fresh state", async (t) => {
  const f = fixture(t),
    first = f.start(),
    firstUrl = new URL(await f.opened);
  assert.throws(
    () => f.start({ sessionId: "another-session" }),
    (error) => error.code === "CONFLICT",
  );
  await f.manager.cancelIdentity("fixture", f.config.url);
  assert.equal(f.manager.get(first.requestId).state, "cancelled");
  const second = f.start(),
    deadline = Date.now() + 3000;
  while (!f.manager.get(second.requestId).authUrl && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(
    new URL(f.manager.get(second.requestId).authUrl).searchParams.get("state"),
    firstUrl.searchParams.get("state"),
  );
  await f.manager.cancel(second.requestId);
});

for (const invalidation of ["cancel", "logout", "configuration", "external-flow"]) {
  test(`an in-flight token response respects ${invalidation} without stale credential writes`, async (t) => {
    let entered,
      release,
      tokenSignal,
      valid = true;
    const tokenStarted = new Promise((resolve) => {
      entered = resolve;
    });
    const tokenGate = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture(t, {
      onToken: async (init) => {
        tokenSignal = init.signal;
        entered();
        await tokenGate;
      },
      validate: async () => {
        if (!valid) throw new Error("Configuration changed");
      },
    });
    const request = f.start(),
      callback = callbackUrl(await f.opened);
    const completing = f.manager.submit(request.requestId, callback.href);
    await tokenStarted;
    let cancelling;
    try {
      if (invalidation === "cancel") cancelling = f.manager.cancel(request.requestId);
      else if (invalidation === "logout") cancelling = f.manager.cancelIdentity("fixture", f.config.url);
      else if (invalidation === "configuration") {
        valid = false;
        cancelling = f.manager.cancelInvalid();
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        const state = await f.store.forServer("fixture", f.config.url).load();
        await f.store.forServer("fixture", f.config.url).save({ ...state, oauthState: "other-cli-flow" });
      }
      assert.equal(tokenSignal.aborted, invalidation === "logout" || invalidation === "configuration");
    } finally {
      release();
    }
    const result = await completing;
    await cancelling;
    const saved = await f.store.forServer("fixture", f.config.url).load();
    assert.equal(
      result.state,
      invalidation === "cancel" ? "succeeded" : invalidation === "external-flow" ? "failed" : "cancelled",
    );
    assert.equal(saved?.tokens?.access_token, invalidation === "cancel" ? "PRIVATE_MCP_TOKEN" : undefined);
  });
}

test("service configuration changes cancel settings-only authorization before code exchange", async (t) => {
  const f = fixture(t),
    service = new McpService({ changed() {}, oauth: f.loginOptions }, f.root);
  t.after(async () => {
    await service.shutdown();
    rmSync(f.root, { recursive: true, force: true });
  });
  const saved = await service.config.upsert("global", undefined, "fixture", f.config, "missing");
  const request = service.login.start({ ...f.input, target: { name: "fixture", scope: "global", cwd: f.root } });
  await f.opened;
  await service.config.upsert(
    "global",
    undefined,
    "fixture",
    { ...f.config, oauth: { ...f.config.oauth, scope: "changed" } },
    saved.revision,
  );
  await service.changed("global");
  assert.equal(service.login.get(request.requestId).state, "cancelled");
  assert.equal(
    f.requests.some((entry) => entry.url.endsWith("/token")),
    false,
  );
  assert.equal((await service.credentials.forServer("fixture", f.config.url).load())?.tokens, undefined);
});

test("service logout cancels the target login and preserves another account at the same URL", async (t) => {
  const f = fixture(t),
    service = new McpService({ changed() {}, oauth: f.loginOptions }, f.root);
  t.after(async () => {
    await service.shutdown();
    rmSync(f.root, { recursive: true, force: true });
  });
  await service.config.upsert("global", undefined, "fixture", f.config, "missing");
  await service.credentials
    .forServer("other", f.config.url)
    .save({ serverUrl: f.config.url, tokens: { access_token: "OTHER_ACCOUNT", token_type: "Bearer" } });
  const request = service.login.start({ ...f.input, target: { name: "fixture", scope: "global", cwd: f.root } });
  await f.opened;
  await service.logout("fixture", f.config.url);
  assert.equal(service.login.get(request.requestId).state, "cancelled");
  assert.equal(await service.credentials.forServer("fixture", f.config.url).load(), undefined);
  assert.equal(
    (await service.credentials.forServer("other", f.config.url).load()).tokens.access_token,
    "OTHER_ACCOUNT",
  );
});
