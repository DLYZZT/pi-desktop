import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManualScheduler } from "#test-timing";

import { BrowserNetworkRecorder } from "./browser-network-recorder.ts";

class FakeCdp {
  listener;
  commands = [];
  bodies = new Map();

  subscribe(_tabId, listener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async enableDomain(tabId, domain, params) {
    this.commands.push({ tabId, method: `${domain}.enable`, params });
    return async () => {
      this.commands.push({ tabId, method: `${domain}.disable` });
    };
  }

  async sendCommand(_tabId, method, params) {
    this.commands.push({ method, params });
    if (method === "Network.getResponseBody") {
      return { body: this.bodies.get(params?.requestId) ?? '{"ok":true}', base64Encoded: false };
    }
    return {};
  }

  emit(method, params) {
    this.listener?.({ method, params });
  }
}

test("network recorder captures redacted metadata, bounded bodies, sealed replay data, and cleanup", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-network-"));
  const cdp = new FakeCdp();
  let now = 1_000;
  const recorder = new BrowserNetworkRecorder({
    tabId: "tab-1",
    cdp,
    bodyDirectory: directory,
    maxRequests: () => 50,
    maxBodyBytes: () => 1024 * 1024,
    now: () => now,
  });
  await recorder.start();
  recorder.armBodyCapture();
  cdp.emit("Network.requestWillBeSent", {
    requestId: "cdp-1",
    type: "Fetch",
    request: {
      url: "https://example.com/api?token=secret&view=1",
      method: "POST",
      headers: { Authorization: "Bearer secret", Cookie: "sid=secret", "Content-Type": "application/json" },
      postData: '{"value":1}',
    },
  });
  const pending = recorder.list({}).requests[0];
  assert.equal(pending.method, "POST");
  assert.match(pending.url, /token=%3Credacted%3E/);
  assert.equal("Authorization" in pending.requestHeaders, false);
  assert.equal("Cookie" in pending.requestHeaders, false);
  assert.equal(recorder.getSealedReplayRecord(pending.requestId).headers.Authorization, "Bearer secret");

  cdp.emit("Network.responseReceived", {
    requestId: "cdp-1",
    type: "Fetch",
    response: {
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      headers: { "Content-Type": "application/json", "Set-Cookie": "sid=secret" },
    },
  });
  cdp.emit("Network.loadingFinished", { requestId: "cdp-1", encodedDataLength: 11 });
  await new Promise((resolve) => setImmediate(resolve));
  const body = await recorder.body(pending.requestId, {});
  assert.equal(body.data, '{"ok":true}');
  assert.equal(body.untrustedWebContent, true);
  assert.equal("Set-Cookie" in recorder.getRequest(pending.requestId).responseHeaders, false);
  const summary = recorder.summary({});
  assert.equal(summary.total, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.byResourceType.Fetch, 1);
  assert.equal(summary.byStatusClass["2xx"], 1);
  assert.deepEqual(Object.keys(summary.recent[0]).sort(), ["method", "requestId", "resourceType", "status", "url"]);

  const waited = recorder.wait({ urlPattern: "*later*" });
  cdp.emit("Network.requestWillBeSent", {
    requestId: "cdp-2",
    type: "XHR",
    request: { url: "https://example.com/later", method: "GET", headers: {} },
  });
  assert.match((await waited).url, /later/);
  now += 10 * 60 * 1_000 + 1;
  assert.throws(
    () => recorder.getSealedReplayRecord(pending.requestId),
    (error) => error.code === "REQUEST_REPLAY_EXPIRED",
  );
  await recorder.stop();
  assert.equal(recorder.count(), 0);
});

test("network recorder creates replay response entries with provenance", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-replay-"));
  try {
    const recorder = new BrowserNetworkRecorder({
      tabId: "tab-1",
      cdp: new FakeCdp(),
      bodyDirectory: directory,
      maxRequests: () => 50,
      maxBodyBytes: () => 1024 * 1024,
    });
    await recorder.start();
    recorder.armBodyCapture();
    const replayed = recorder.recordReplay({
      replayedFrom: "source-request",
      method: "PUT",
      url: "https://example.com/api",
      requestHeaders: { Authorization: "secret", "Content-Type": "application/json" },
      status: 204,
      statusText: "No Content",
      responseHeaders: {},
      body: Buffer.alloc(0),
      mimeType: "application/json",
    });
    assert.equal(replayed.replayedFrom, "source-request");
    assert.equal(replayed.method, "PUT");
    assert.equal(replayed.requestHeaders.Authorization, undefined);
    await recorder.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network recorder reports truncation and evicts body files in deterministic LRU order", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-body-lru-"));
  try {
    const cdp = new FakeCdp();
    cdp.bodies.set("cdp-1", "12345678");
    cdp.bodies.set("cdp-2", "abcdefghijklmnopqrst");
    const recorder = new BrowserNetworkRecorder({
      tabId: "tab-1",
      cdp,
      bodyDirectory: directory,
      maxRequests: () => 50,
      maxBodyBytes: () => 10,
    });
    await recorder.start();
    recorder.armBodyCapture();
    for (const [requestId, url, encodedDataLength] of [
      ["cdp-1", "https://example.com/one", 8],
      ["cdp-2", "https://example.com/two", 20],
    ]) {
      cdp.emit("Network.requestWillBeSent", {
        requestId,
        type: "Fetch",
        request: { url, method: "GET", headers: {} },
      });
      cdp.emit("Network.responseReceived", {
        requestId,
        type: "Fetch",
        response: { status: 200, mimeType: "text/plain", headers: {} },
      });
      cdp.emit("Network.loadingFinished", { requestId, encodedDataLength });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const requests = recorder.list({}).requests;
    assert.equal(recorder.getRequest(requests[0].requestId).bodyAvailable, false);
    const secondBody = await recorder.body(requests[1].requestId, {});
    assert.equal(secondBody.data, "abcdefghij");
    assert.equal(secondBody.totalBytes, 20);
    assert.equal(secondBody.truncated, true);
    await recorder.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network recorder suspends body and sealed replay capture after idle while retaining metadata", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-body-idle-"));
  try {
    const cdp = new FakeCdp();
    const scheduler = createManualScheduler();
    const recorder = new BrowserNetworkRecorder({
      tabId: "tab-1",
      cdp,
      bodyDirectory: directory,
      maxRequests: () => 50,
      maxBodyBytes: () => 1024 * 1024,
      bodyCaptureIdleMs: 25,
      timers: scheduler,
    });
    await recorder.start();
    recorder.armBodyCapture();
    cdp.emit("Network.requestWillBeSent", {
      requestId: "cdp-active",
      type: "Fetch",
      request: { url: "https://example.com/active", method: "POST", headers: {}, postData: "secret" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "cdp-active",
      type: "Fetch",
      response: { status: 200, mimeType: "application/json", headers: {} },
    });
    cdp.emit("Network.loadingFinished", { requestId: "cdp-active", encodedDataLength: 11 });
    await new Promise((resolve) => setImmediate(resolve));
    const active = recorder.list({}).requests[0];
    assert.equal(recorder.getRequest(active.requestId).bodyAvailable, true);
    assert.equal(recorder.getSealedReplayRecord(active.requestId).method, "POST");

    await scheduler.runNext();
    assert.equal(recorder.count(), 1, "request metadata remains available after payload capture idles");
    assert.equal(recorder.getRequest(active.requestId).bodyAvailable, false);
    assert.throws(
      () => recorder.getSealedReplayRecord(active.requestId),
      (error) => error.code === "REQUEST_REPLAY_EXPIRED",
    );

    const bodyReadsBeforeIdleRequest = cdp.commands.filter(({ method }) => method === "Network.getResponseBody").length;
    cdp.emit("Network.requestWillBeSent", {
      requestId: "cdp-idle",
      type: "Fetch",
      request: { url: "https://example.com/idle", method: "GET", headers: {} },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "cdp-idle",
      type: "Fetch",
      response: { status: 200, mimeType: "application/json", headers: {} },
    });
    cdp.emit("Network.loadingFinished", { requestId: "cdp-idle", encodedDataLength: 11 });
    await new Promise((resolve) => setImmediate(resolve));
    const idle = recorder.list({}).requests.find(({ url }) => url.endsWith("/idle"));
    assert.equal(recorder.getRequest(idle.requestId).bodyAvailable, false);
    assert.equal(
      cdp.commands.filter(({ method }) => method === "Network.getResponseBody").length,
      bodyReadsBeforeIdleRequest,
      "idle metadata capture does not read response bodies",
    );

    recorder.armBodyCapture();
    cdp.emit("Network.requestWillBeSent", {
      requestId: "cdp-rearmed",
      type: "Fetch",
      request: { url: "https://example.com/rearmed", method: "GET", headers: {} },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "cdp-rearmed",
      type: "Fetch",
      response: { status: 200, mimeType: "application/json", headers: {} },
    });
    cdp.emit("Network.loadingFinished", { requestId: "cdp-rearmed", encodedDataLength: 11 });
    await new Promise((resolve) => setImmediate(resolve));
    const rearmed = recorder.list({}).requests.find(({ url }) => url.endsWith("/rearmed"));
    assert.equal(recorder.getRequest(rearmed.requestId).bodyAvailable, true);
    assert.equal(recorder.getSealedReplayRecord(rearmed.requestId).method, "GET");
    await recorder.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
