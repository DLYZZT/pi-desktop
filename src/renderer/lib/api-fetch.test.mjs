import assert from "node:assert/strict";
import test from "node:test";

import { isApiShimRequest } from "./api-fetch-policy.ts";

test("fetch shim handles only relative API paths or the exact app origin", () => {
  const production = "app://bundle/index.html";
  assert.equal(isApiShimRequest("/api/sessions", production), true);
  assert.equal(isApiShimRequest(new URL("app://bundle/api/models"), production), true);
  assert.equal(isApiShimRequest("https://example.test/path/api/sessions", production), false);
  assert.equal(isApiShimRequest("app://preview/token/api/asset", production), false);
  assert.equal(isApiShimRequest("/not-api/sessions", production), false);

  const development = "http://localhost:5173/index.html";
  assert.equal(isApiShimRequest("http://localhost:5173/api/sessions", development), true);
  assert.equal(isApiShimRequest("http://localhost:5173.evil.test/api/sessions", development), false);
  assert.equal(isApiShimRequest("http://127.0.0.1:5173/api/sessions", development), false);
});
