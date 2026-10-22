import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { discoverProviderModels } from "./model-discovery.ts";

const { Response } = globalThis;

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("root discovery falls back to /v1/models, resolves SDK auth expressions and deduplicates IDs", async (t) => {
  const previousKey = process.env.PI_DISCOVERY_TEST_KEY;
  process.env.PI_DISCOVERY_TEST_KEY = "fixture-secret";
  t.after(() => {
    if (previousKey === undefined) delete process.env.PI_DISCOVERY_TEST_KEY;
    else process.env.PI_DISCOVERY_TEST_KEY = previousKey;
  });
  const requests = [];
  const baseUrl = await serverFixture(t, (req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, "Bearer fixture-secret");
    assert.equal(req.headers["x-fixture"], "fixture-secret");
    if (req.url === "/models") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          { id: "vendor/model-b", name: "Model B", reasoning: true },
          { id: "model-a" },
          { id: "model-a" },
          null,
          {},
          { id: "" },
        ],
      }),
    );
  });
  const result = await discoverProviderModels({
    api: "openai-responses",
    baseUrl: `${baseUrl}/`,
    apiKey: "$PI_DISCOVERY_TEST_KEY",
    headers: { "x-fixture": "${PI_DISCOVERY_TEST_KEY}", "x-unused": null },
  });
  assert.deepEqual(requests, ["/models", "/v1/models"]);
  assert.deepEqual(result, {
    ok: true,
    baseUrl: `${baseUrl}/v1`,
    models: [{ id: "model-a" }, { id: "vendor/model-b", name: "Model B" }],
  });
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("explicit API prefixes and model-list URLs are preserved, including an empty model list", async () => {
  for (const suffix of ["/api/v1", "/api/v1/", "/api/v1/models/"]) {
    const result = await discoverProviderModels(
      { baseUrl: `https://fixture.invalid${suffix}`, headers: { Authorization: "Bearer custom" } },
      {
        fetch: async (url, options) => {
          assert.equal(String(url), "https://fixture.invalid/api/v1/models");
          assert.equal(options.headers.get("authorization"), "Bearer custom");
          assert.equal(options.redirect, "error");
          return Response.json({ data: [] });
        },
      },
    );
    assert.deepEqual(result, { ok: true, baseUrl: "https://fixture.invalid/api/v1", models: [] });
  }
});

test("authentication failures are not retried or reflected with server secrets", async () => {
  let requests = 0;
  const result = await discoverProviderModels(
    { baseUrl: "https://fixture.invalid", apiKey: "fixture" },
    {
      fetch: async () => {
        requests++;
        return new Response("leaked-server-secret", { status: 401 });
      },
    },
  );
  assert.equal(requests, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /authentication/);
  assert.ok(!result.error.includes("leaked-server-secret"));
});

test("HTML fallback works but malformed, oversized and ID-less model responses fail", async () => {
  let requests = 0;
  const root = await discoverProviderModels(
    { baseUrl: "https://fixture.invalid" },
    {
      fetch: async () =>
        ++requests === 1 ? new Response("<html>app</html>") : Response.json({ data: [{ id: "model" }] }),
    },
  );
  assert.equal(root.ok, true);
  assert.equal(root.baseUrl, "https://fixture.invalid/v1");
  for (const body of ['{"models":[]}', '{"data":[{}]}', "<html>bad</html>", "x".repeat(2 * 1024 * 1024 + 1)]) {
    const result = await discoverProviderModels(
      { baseUrl: "https://fixture.invalid/v1" },
      {
        fetch: async () => new Response(body),
      },
    );
    assert.equal(result.ok, false);
  }
});

test("invalid configuration fails before sending a request", async () => {
  const invalid = [
    undefined,
    {},
    { baseUrl: "not a URL" },
    { baseUrl: "file:///tmp/models" },
    { baseUrl: "https://user:password@fixture.invalid" },
    { baseUrl: "https://fixture.invalid?api_key=secret" },
    { baseUrl: "https://fixture.invalid", api: "anthropic-messages" },
    { baseUrl: "https://fixture.invalid", headers: { invalid: 42 } },
    { baseUrl: "https://fixture.invalid", apiKey: "${PI_DISCOVERY_MISSING_FIXTURE}" },
  ];
  for (const provider of invalid) {
    const result = await discoverProviderModels(provider, { fetch: () => assert.fail("Unexpected request") });
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("password"));
    assert.ok(!result.error.includes("api_key=secret"));
  }
});

test("discovery times out and refuses credential-bearing redirects", async (t) => {
  let redirected = false;
  const baseUrl = await serverFixture(t, (req, res) => {
    if (req.url === "/redirect/models") res.writeHead(302, { Location: "/target" }).end();
    else if (req.url === "/target") {
      redirected = true;
      res.end("{}");
    }
  });
  const timedOut = await discoverProviderModels({ baseUrl: `${baseUrl}/slow` }, { timeoutMs: 50 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timed out/);
  const redirect = await discoverProviderModels({ baseUrl: `${baseUrl}/redirect`, apiKey: "fixture" });
  assert.equal(redirect.ok, false);
  assert.equal(redirected, false);
});
