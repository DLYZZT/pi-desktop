import assert from "node:assert/strict";
import test from "node:test";
import { catalogRequestHeaders } from "./verify-toolchain-catalog-upstream.mjs";

test("upstream catalog verification authenticates only the official GitHub API", () => {
  const headers = catalogRequestHeaders("https://api.github.com/repos/example/tool/releases/tags/v1", "fixture-token", {
    "X-GitHub-Api-Version": "2022-11-28",
  });
  assert.equal(headers.get("authorization"), "Bearer fixture-token");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.ok(headers.get("user-agent"));
  assert.equal(catalogRequestHeaders("https://api.github.com/rate_limit").has("authorization"), false);
});

test("Node.js and other artifact origins never receive the GitHub catalog token", () => {
  const overrides = { Authorization: "Bearer inherited-fixture", "X-Check": "retained" };
  for (const url of [
    "https://nodejs.org/dist/v24.18.0/SHASUMS256.txt",
    "https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz",
    "https://github.com/example/tool/releases/download/v1/tool.zip",
    "https://api.github.com.evil.invalid/asset",
    "http://api.github.com/rate_limit",
    "https://api.github.com:8443/rate_limit",
  ]) {
    const headers = catalogRequestHeaders(url, "fixture-token", overrides);
    assert.equal(headers.has("authorization"), false, url);
    assert.equal(headers.get("x-check"), "retained");
  }
  assert.equal(overrides.Authorization, "Bearer inherited-fixture");
});
