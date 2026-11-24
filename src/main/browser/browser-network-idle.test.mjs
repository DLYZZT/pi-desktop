import assert from "node:assert/strict";
import test from "node:test";

import { BrowserNetworkIdleProbe } from "./browser-network-idle.ts";

function fixture() {
  const listeners = new Set();
  let releaseCount = 0;
  const cdp = {
    enableDomain: async () => {
      return async () => {
        releaseCount += 1;
      };
    },
    subscribe: (_tabId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    probe: new BrowserNetworkIdleProbe(cdp),
    emit(method, params) {
      for (const listener of listeners) listener({ method, params });
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

test("resolves after a quiet window when no requests are in flight", async () => {
  const value = fixture();
  const started = Date.now();
  assert.equal(await value.probe.wait("tab", { timeoutMs: 1_000, quietMs: 50 }), true);
  assert.ok(Date.now() - started >= 50);
  assert.equal(value.releaseCount, 1);
});

test("waits for in-flight requests and ignores websockets", async () => {
  const value = fixture();
  const pending = value.probe.wait("tab", { timeoutMs: 2_000, quietMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  value.emit("Network.requestWillBeSent", {
    requestId: "ws-1",
    type: "WebSocket",
    request: { url: "wss://example.com/socket" },
  });
  value.emit("Network.requestWillBeSent", {
    requestId: "xhr-1",
    type: "XHR",
    request: { url: "https://example.com/api" },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  value.emit("Network.loadingFinished", { requestId: "xhr-1" });
  assert.equal(await pending, true);
  assert.equal(value.releaseCount, 1);
});

test("times out when a request never finishes", async () => {
  const value = fixture();
  const pending = value.probe.wait("tab", { timeoutMs: 150, quietMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  value.emit("Network.requestWillBeSent", {
    requestId: "xhr-1",
    type: "Fetch",
    request: { url: "https://example.com/slow" },
  });
  await assert.rejects(pending, (error) => error.code === "ACTION_TIMEOUT");
  assert.equal(value.releaseCount, 1);
});

test("reports an unavailable Network domain so the caller can fall back", async () => {
  const cdp = {
    enableDomain: async () => {
      throw new Error("attached elsewhere");
    },
    subscribe: () => () => {},
  };
  const probe = new BrowserNetworkIdleProbe(cdp);
  assert.equal(await probe.wait("tab", { timeoutMs: 100 }), false);
});
