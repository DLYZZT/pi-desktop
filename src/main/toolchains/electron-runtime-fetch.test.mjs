import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createElectronRuntimeFetch } from "./electron-runtime-fetch.ts";

class FakeRequest extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.headers = new Map();
    this.followed = 0;
    this.aborted = 0;
    this.ended = 0;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  followRedirect() {
    this.followed += 1;
  }

  abort() {
    this.aborted += 1;
  }

  end() {
    this.ended += 1;
    return this;
  }
}

class FakeIncomingMessage extends EventEmitter {
  constructor(statusCode = 200, rawHeaders = []) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusCode === 200 ? "OK" : "Error";
    this.rawHeaders = rawHeaders;
  }
}

function harness() {
  let request;
  const fetchImpl = createElectronRuntimeFetch((options) => {
    request = new FakeRequest(options);
    return request;
  });
  return {
    fetchImpl,
    get request() {
      return request;
    },
  };
}

test("follows only an allowlisted Electron redirect and streams its response", async () => {
  const state = harness();
  const pending = state.fetchImpl("https://github.com/astral-sh/uv/releases/download/0.11.29/uv.tar.gz", {
    headers: { Accept: "application/octet-stream" },
  });
  assert.equal(state.request.options.redirect, "manual");
  assert.equal(state.request.options.bypassCustomProtocolHandlers, true);
  assert.equal(state.request.headers.get("accept"), "application/octet-stream");
  assert.equal(state.request.ended, 1);

  state.request.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/fixed/uv.tar.gz", {});
  assert.equal(state.request.followed, 1);

  const incoming = new FakeIncomingMessage(200, ["Content-Length", "8", "Content-Type", "application/octet-stream"]);
  state.request.emit("response", incoming);
  const response = await pending;
  incoming.emit("data", Buffer.from("verified"));
  incoming.emit("end");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "8");
  assert.equal(await response.text(), "verified");
});

test("rejects an Electron redirect outside the runtime host allowlist", async () => {
  const state = harness();
  const pending = state.fetchImpl("https://github.com/astral-sh/uv/releases/download/0.11.29/uv.tar.gz");
  state.request.emit("redirect", 302, "GET", "https://evil.invalid/uv.tar.gz", {});
  await assert.rejects(pending, (error) => error.code === "TOOLCHAIN_DOWNLOAD_REJECTED");
  assert.equal(state.request.followed, 0);
  assert.equal(state.request.aborted, 1);
});

test("does not treat close during a followed redirect as a terminal failure", async () => {
  const state = harness();
  const pending = state.fetchImpl("https://github.com/astral-sh/uv/releases/download/0.11.29/uv.tar.gz");
  state.request.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/fixed/uv.tar.gz", {});
  state.request.emit("close");

  const incoming = new FakeIncomingMessage(200, ["Content-Length", "2"]);
  state.request.emit("response", incoming);
  const response = await pending;
  incoming.emit("data", Buffer.from("ok"));
  incoming.emit("end");
  assert.equal(await response.text(), "ok");
});

test("enforces the redirect limit before synchronously following", async () => {
  const state = harness();
  const pending = state.fetchImpl("https://github.com/astral-sh/uv/releases/download/0.11.29/uv.tar.gz");
  for (let index = 0; index < 6; index += 1) {
    state.request.emit(
      "redirect",
      302,
      "GET",
      `https://release-assets.githubusercontent.com/fixed/uv-${index}.tar.gz`,
      {},
    );
  }
  await assert.rejects(pending, (error) => error.code === "TOOLCHAIN_DOWNLOAD_REJECTED");
  assert.equal(state.request.followed, 5);
  assert.equal(state.request.aborted, 1);
});

test("aborts an Electron request when the caller cancels", async () => {
  const state = harness();
  const controller = new globalThis.AbortController();
  const pending = state.fetchImpl("https://nodejs.org/dist/v24.18.0/node.tar.gz", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(state.request.aborted, 1);
});
