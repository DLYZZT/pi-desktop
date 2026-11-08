import assert from "node:assert/strict";
import test from "node:test";
import { createGithubReleaseFetch } from "./ci-github-fetch.mjs";

const assetUrl = "https://github.com/example/runtime/releases/download/v1.0.0/runtime.zip";
const metadataUrl = "https://api.github.com/repos/example/runtime/releases/tags/v1.0.0";
const apiAssetUrl = "https://api.github.com/repos/example/runtime/releases/assets/123";
const cdnUrl = "https://release-assets.githubusercontent.com/asset.zip?signature=fixture";
const metadata = { assets: [{ id: 123, name: "runtime.zip", url: "https://untrusted.invalid/ignored" }] };

test("CI fetch leaves unrelated requests and their credentials untouched", async () => {
  const input = "https://registry.npmjs.org/example",
    init = { headers: { authorization: "caller-owned" } };
  const expected = new globalThis.Response("original");
  const fetch = createGithubReleaseFetch(
    async (url, options) => {
      assert.equal(url, input);
      assert.equal(options, init);
      return expected;
    },
    { token: "CI_TOKEN" },
  );
  assert.equal(await fetch(input, init), expected);
});

test("CI fetch uses the exact asset API, caches metadata and never forwards its token to the CDN", async () => {
  const calls = [];
  const fetch = createGithubReleaseFetch(
    async (input, init) => {
      const url = String(input),
        headers = new globalThis.Headers(init.headers);
      calls.push(url);
      if (url === metadataUrl) {
        assert.equal(headers.get("authorization"), "Bearer CI_TOKEN");
        assert.equal(init.redirect, "error");
        return globalThis.Response.json(metadata);
      }
      if (url === apiAssetUrl) {
        assert.equal(headers.get("authorization"), "Bearer CI_TOKEN");
        assert.equal(headers.get("accept"), "application/octet-stream");
        return new globalThis.Response(null, { status: 302, headers: { location: cdnUrl } });
      }
      assert.equal(url, cdnUrl);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("accept-encoding"), "identity");
      return new globalThis.Response("verified bytes");
    },
    { token: "CI_TOKEN" },
  );
  const headers = new globalThis.Headers({ "accept-encoding": "identity", authorization: "caller-token" });
  for (let i = 0; i < 2; i++) assert.equal(await (await fetch(assetUrl, { headers })).text(), "verified bytes");
  assert.equal(calls.filter((url) => url === metadataUrl).length, 1);
  assert.equal(headers.get("authorization"), "caller-token");
});

test("manual redirect callers keep their own redirect validation", async () => {
  const calls = [];
  const fetch = createGithubReleaseFetch(async (input) => {
    calls.push(String(input));
    return String(input) === metadataUrl
      ? globalThis.Response.json(metadata)
      : new globalThis.Response(null, { status: 302, headers: { location: cdnUrl } });
  });
  const response = await fetch(assetUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), cdnUrl);
  assert.deepEqual(calls, [metadataUrl, apiAssetUrl]);
});

test("CI fetch rejects an unexpected redirect before contacting its host", async () => {
  const calls = [];
  const fetch = createGithubReleaseFetch(
    async (input) => {
      calls.push(String(input));
      return String(input) === metadataUrl
        ? globalThis.Response.json(metadata)
        : new globalThis.Response(null, { status: 302, headers: { location: "https://evil.invalid/asset" } });
    },
    { token: "CI_TOKEN" },
  );
  await assert.rejects(fetch(assetUrl), /redirect was rejected/);
  assert.deepEqual(calls, [metadataUrl, apiAssetUrl]);
});

test("CI fetch retries transient metadata errors but bounds permanent failures", async () => {
  let attempts = 0;
  const delays = [];
  const fetch = createGithubReleaseFetch(
    async (input) => {
      if (String(input) !== metadataUrl) return new globalThis.Response("asset");
      attempts++;
      if (attempts === 1) throw new TypeError("transient socket failure");
      if (attempts === 2)
        return new globalThis.Response(
          new globalThis.ReadableStream({
            start(controller) {
              controller.error(new Error("truncated gateway response"));
            },
          }),
          { status: 504 },
        );
      return globalThis.Response.json(metadata);
    },
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );
  assert.equal(await (await fetch(assetUrl)).text(), "asset");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  let deniedCalls = 0;
  const denied = createGithubReleaseFetch(async () => {
    deniedCalls++;
    return new globalThis.Response(null, { status: 403 });
  });
  await assert.rejects(denied(assetUrl), /metadata failed \(403\)/);
  assert.equal(deniedCalls, 1);
});

test("CI fetch observes caller cancellation before any request", async () => {
  const controller = new globalThis.AbortController();
  controller.abort(new Error("fixture cancellation"));
  const fetch = createGithubReleaseFetch(async () => assert.fail("cancelled download made a request"));
  await assert.rejects(fetch(assetUrl, { signal: controller.signal }), /fixture cancellation/);
});

test("CI fetch refuses a missing or invalid release asset identity", async () => {
  for (const assets of [[], [{ name: "runtime.zip", id: -1 }]]) {
    let calls = 0;
    const fetch = createGithubReleaseFetch(async () => {
      calls++;
      return globalThis.Response.json({ assets });
    });
    await assert.rejects(fetch(assetUrl), /asset is missing/);
    assert.equal(calls, 1);
  }
});
