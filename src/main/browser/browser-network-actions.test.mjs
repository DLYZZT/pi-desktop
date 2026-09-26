import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { BrowserError } from "./browser-error.ts";
import { readBrowserNetworkBody, replayBrowserRequest } from "./browser-network-actions.ts";

function fixture(method = "GET") {
  const checked = [],
    requests = [],
    recorded = [];
  const sealed = {
    method,
    url: "https://fixture.test/start",
    headers: { Host: "unsafe", Cookie: "unsafe", "content-type": "text/plain" },
    postData: method === "POST" ? "request body" : undefined,
  };
  const services = {
    recorder: {
      armBodyCapture() {},
      async body() {
        return { text: "stored body" };
      },
      getRequest() {
        return { method };
      },
      getSealedReplayRecord() {
        return sealed;
      },
      recordRefetchedBody(id, data, mime) {
        recorded.push({ id, data: data.toString(), mime });
        return { text: data.toString() };
      },
      recordReplay(data) {
        recorded.push(data);
        return { requestId: "replayed" };
      },
    },
    session: {
      async fetch(url, options) {
        requests.push({ url, options });
        return new globalThis.Response("response", { headers: { "content-type": "text/plain" } });
      },
    },
    async checkUrl(url) {
      checked.push(url);
      return { url };
    },
    timeoutMs: () => 1000,
  };
  return { services, checked, requests, recorded };
}

test("network body fallback checks the sealed GET URL and filters protected headers", async () => {
  const state = fixture();
  state.services.recorder.body = async () => {
    throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "missing");
  };
  const result = await readBrowserNetworkBody(state.services, "original", {}, new globalThis.AbortController().signal);
  assert.equal(result.text, "response");
  assert.deepEqual(state.checked, ["https://fixture.test/start"]);
  assert.deepEqual(state.requests[0].options.headers, { "content-type": "text/plain" });
  assert.equal(state.requests[0].options.redirect, "error");
  state.services.recorder.getRequest = () => ({ method: "POST" });
  await assert.rejects(readBrowserNetworkBody(state.services, "original", {}, new globalThis.AbortController().signal));
  assert.equal(state.requests.length, 1);
});

test("mutating replay waits for approval before using the original session fetch", async () => {
  const state = fixture("POST"),
    approval = createDeferred(),
    requested = createDeferred();
  const replay = replayBrowserRequest(
    state.services,
    "original",
    undefined,
    "fixture check",
    new globalThis.AbortController().signal,
    async (description) => {
      assert.match(description, /Replay POST to https:\/\/fixture.test/);
      requested.resolve();
      await approval.promise;
    },
  );
  await requested.promise;
  assert.equal(state.requests.length, 0);
  approval.resolve();
  const result = await replay;
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].options.body, "request body");
  assert.equal(state.requests[0].options.method, "POST");
  assert.equal(result.request.requestId, "replayed");
  assert.deepEqual(state.recorded[0].requestHeaders, { "content-type": "text/plain" });
});

test("GET redirects are rechecked and cross-origin redirects never issue a second request", async () => {
  const state = fixture();
  state.services.session.fetch = async (url, options) => {
    state.requests.push({ url, options });
    return state.requests.length === 1
      ? new globalThis.Response(null, { status: 302, headers: { location: "/next" } })
      : new globalThis.Response("ok");
  };
  await replayBrowserRequest(
    state.services,
    "original",
    undefined,
    "read fixture",
    new globalThis.AbortController().signal,
    async () => assert.fail("GET should not request mutation approval"),
  );
  assert.deepEqual(state.checked, ["https://fixture.test/start", "https://fixture.test/next"]);
  const denied = fixture();
  denied.services.session.fetch = async (url, options) => {
    denied.requests.push({ url, options });
    return new globalThis.Response(null, { status: 302, headers: { location: "https://other.test/" } });
  };
  await assert.rejects(
    replayBrowserRequest(
      denied.services,
      "original",
      undefined,
      "fixture",
      new globalThis.AbortController().signal,
      async () => {},
    ),
    (error) => error.code === "REQUEST_REPLAY_BLOCKED",
  );
  assert.equal(denied.requests.length, 1);
});

test("protected overrides and oversized request bodies fail before approval or IO", async () => {
  const state = fixture("POST");
  for (const overrides of [{ headers: { Cookie: "forbidden" } }, { body: "x".repeat(8 * 1024 * 1024 + 1) }]) {
    await assert.rejects(
      replayBrowserRequest(
        state.services,
        "original",
        overrides,
        "fixture",
        new globalThis.AbortController().signal,
        async () => assert.fail("invalid request must not prompt"),
      ),
    );
  }
  assert.equal(state.requests.length, 0);
});
