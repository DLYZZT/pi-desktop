import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { createRpcClient, createRpcServer } from "./rpc.ts";
import { RpcError } from "./types.ts";
import { ToolchainError } from "../shared/toolchains/errors.ts";

function createPair(t) {
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer();
  server.attachPort(port1);
  const client = createRpcClient(port2);
  t.after(() => {
    client.close();
    server.detachPort(port1);
  });
  return { client, server };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("performs request/response calls and reports missing methods", async (t) => {
  const { client, server } = createPair(t);
  server.handle({ "host.ping": () => ({ ok: true, ts: 42 }) });

  assert.deepEqual(await client.call("host.ping"), { ok: true, ts: 42 });
  await assert.rejects(client.call("not.registered"), (error) => {
    assert.equal(error instanceof RpcError, true);
    assert.equal(error.code, "METHOD_NOT_FOUND");
    assert.match(error.message, /not\.registered/);
    return true;
  });
  for (const inheritedName of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(client.call(inheritedName), (error) => {
      assert.equal(error instanceof RpcError, true);
      assert.equal(error.code, "METHOD_NOT_FOUND");
      assert.match(error.message, new RegExp(inheritedName));
      return true;
    });
  }
});

test("serializes RpcError detail and maps ordinary errors to INTERNAL", async (t) => {
  const { client, server } = createPair(t);
  server.handle({
    "host.ping": () => {
      throw new RpcError({ code: "FORBIDDEN", message: "No access", detail: { path: "/secret" } });
    },
    "sessions.list": () => {
      throw new Error("database unavailable");
    },
  });

  await assert.rejects(client.call("host.ping"), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.message, "No access");
    assert.deepEqual(error.detail, { path: "/secret" });
    return true;
  });
  await assert.rejects(client.call("sessions.list"), (error) => {
    assert.equal(error.code, "INTERNAL");
    assert.equal(error.message, "database unavailable");
    return true;
  });
});

test("preserves structured toolchain errors across the RPC boundary", async (t) => {
  const { client, server } = createPair(t);
  server.handle({
    "host.ping": () => {
      throw new ToolchainError({
        code: "TOOLCHAIN_NODE_REQUIRED",
        capability: "js.npm",
        causeCode: "ENOENT",
        message: "Node.js with npm is required",
      });
    },
  });

  await assert.rejects(client.call("host.ping"), (error) => {
    assert.equal(error.code, "TOOLCHAIN_NODE_REQUIRED");
    assert.equal(error.message, "Node.js with npm is required");
    assert.deepEqual(error.detail, { capability: "js.npm", causeCode: "ENOENT" });
    return true;
  });
});

test("returns a minimal error when a handler result cannot be structured-cloned", async (t) => {
  const { client, server } = createPair(t);
  server.handle({
    "host.ping": () => ({ ok: true, uncloneable: () => undefined }),
  });

  await assert.rejects(client.call("host.ping"), (error) => {
    assert.equal(error instanceof RpcError, true);
    assert.equal(error.code, "SERIALIZATION_FAILED");
    assert.equal(error.message, "RPC response could not be serialized");
    return true;
  });
});

test("matches exact and wildcard subscriptions and isolates subscriber errors", async (t) => {
  const { client, server } = createPair(t);
  server.handle({ "host.ping": () => ({ ok: true, ts: 1 }) });
  const received = [];
  client.subscribe("files.changed", "/project", () => {
    throw new Error("subscriber failure");
  });
  client.subscribe("files.changed", "/project", (event) => received.push(["exact", event.event]));
  client.subscribe("files.changed", "*", (event) => received.push(["client-wildcard", event.event]));
  await client.call("host.ping");

  server.emit("files.changed", "/project", { event: "change", path: "/project/a" });
  server.emit("files.changed", "*", { event: "rename", path: "/project/b" });
  await nextTurn();

  assert.deepEqual(received, [
    ["exact", "change"],
    ["client-wildcard", "change"],
    ["exact", "rename"],
    ["client-wildcard", "rename"],
  ]);
});

test("unsubscribe prevents later events", async (t) => {
  const { client, server } = createPair(t);
  server.handle({ "host.ping": () => ({ ok: true, ts: 1 }) });
  let calls = 0;
  const unsubscribe = client.subscribe("files.changed", "/project", () => {
    calls += 1;
  });
  await client.call("host.ping");
  unsubscribe();
  await client.call("host.ping");

  server.emit("files.changed", "/project", { event: "change", path: "/project/a" });
  await nextTurn();
  assert.equal(calls, 0);
});

test("client close rejects pending calls", async () => {
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer();
  server.handle({ "host.ping": () => new Promise(() => {}) });
  server.attachPort(port1);
  const client = createRpcClient(port2);
  const pending = client.call("host.ping");
  await nextTurn();

  client.close();
  await assert.rejects(pending, (error) => error instanceof RpcError && error.code === "CLOSED");
  server.detachPort(port1);
});

test("client calls time out and remote close settles pending calls", async () => {
  {
    const { port1, port2 } = new MessageChannel();
    const server = createRpcServer();
    server.handle({ "host.ping": () => new Promise(() => {}) });
    server.attachPort(port1);
    const client = createRpcClient(port2, { callTimeoutMs: 20 });

    await assert.rejects(client.call("host.ping"), (error) => error instanceof RpcError && error.code === "TIMEOUT");
    client.close();
    server.detachPort(port1);
  }

  {
    const { port1, port2 } = new MessageChannel();
    const server = createRpcServer();
    server.handle({ "host.ping": () => new Promise(() => {}) });
    server.attachPort(port1);
    const client = createRpcClient(port2, { callTimeoutMs: 1_000 });
    const pending = client.call("host.ping");
    await nextTurn();
    port1.close();

    await assert.rejects(pending, (error) => error instanceof RpcError && error.code === "CLOSED");
    client.close();
  }
});

test("postMessage failure rejects and removes a pending call", async () => {
  const listeners = new Set();
  const port = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    start() {},
    postMessage() {
      throw new Error("closed transport");
    },
    close() {},
  };
  const client = createRpcClient(port);

  await assert.rejects(client.call("host.ping"), /closed transport/);
  client.close();
  assert.equal(listeners.size, 0);
});

test("subscribe throws without retaining a local subscription when postMessage fails", () => {
  const listeners = new Set();
  const port = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    start() {},
    postMessage() {
      throw new Error("closed subscription transport");
    },
    close() {},
  };
  const client = createRpcClient(port);
  let calls = 0;

  assert.throws(() => client.subscribe("files.changed", "/project", () => calls++), /closed subscription transport/);
  for (const listener of listeners) {
    listener({
      data: { kind: "event", topic: "files.changed", key: "/project", data: { event: "change", path: "a" } },
    });
  }
  assert.equal(calls, 0);
  client.close();
});

test("server attach/detach is idempotent and removes message and close listeners", () => {
  const listeners = new Map();
  let closeCalls = 0;
  const port = {
    on(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage() {},
    start() {},
    close() {
      closeCalls += 1;
    },
  };
  const server = createRpcServer();

  server.attachPort(port);
  server.attachPort(port);
  assert.equal(listeners.get("message").size, 1);
  assert.equal(listeners.get("close").size, 1);

  server.detachPort(port);
  server.detachPort(port);
  assert.equal(listeners.get("message").size, 0);
  assert.equal(listeners.get("close").size, 0);
  assert.equal(closeCalls, 1);
});

test("port leases replace, release explicitly, and finalize on detach", async () => {
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer();
  const client = createRpcClient(port2);
  const released = [];
  let calls = 0;
  server.handle({
    "host.ping": (_params, context) => {
      calls += 1;
      if (calls === 3) context.releaseLease("watch:/project");
      else context.setLease("watch:/project", () => released.push(calls));
      return { ok: true, ts: calls };
    },
  });
  server.attachPort(port1);

  await client.call("host.ping");
  await client.call("host.ping");
  assert.deepEqual(released, [2], "replacing a lease releases its prior resource");
  await client.call("host.ping");
  assert.deepEqual(released, [2, 3], "explicit release finalizes the current resource");
  await client.call("host.ping");
  server.detachPort(port1);
  assert.deepEqual(released, [2, 3, 4], "detach finalizes all remaining port resources");
  client.close();
});

test("remote port close finalizes owned resources", async () => {
  const { port1, port2 } = new MessageChannel();
  const server = createRpcServer();
  const client = createRpcClient(port2);
  let releases = 0;
  server.handle({
    "host.ping": (_params, context) => {
      context.setLease("watch:/project", () => releases++);
      return { ok: true, ts: 1 };
    },
  });
  server.attachPort(port1);
  await client.call("host.ping");

  client.close();
  for (let attempt = 0; attempt < 10 && releases === 0; attempt += 1) await nextTurn();
  assert.equal(releases, 1);
});

test("server detaches a port when response fallback or event delivery also fails", async () => {
  const listeners = new Map();
  let closeCalls = 0;
  const port = {
    on(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage() {
      throw new Error("closed transport");
    },
    start() {},
    close() {
      closeCalls += 1;
    },
  };
  const responseServer = createRpcServer();
  responseServer.handle({ "host.ping": () => ({ ok: true }) });
  responseServer.attachPort(port);
  listeners.get("message").values().next().value({ kind: "request", id: "r1", method: "host.ping" });
  await nextTurn();

  assert.equal(closeCalls, 1);
  assert.equal(listeners.get("message").size, 0);
  assert.equal(listeners.get("close").size, 0);

  const eventListeners = new Map();
  let eventCloseCalls = 0;
  const eventPort = {
    on(type, listener) {
      const entries = eventListeners.get(type) ?? new Set();
      entries.add(listener);
      eventListeners.set(type, entries);
    },
    off(type, listener) {
      eventListeners.get(type)?.delete(listener);
    },
    postMessage() {
      throw new Error("uncloneable event");
    },
    start() {},
    close() {
      eventCloseCalls += 1;
    },
  };
  const eventServer = createRpcServer();
  eventServer.attachPort(eventPort);
  eventListeners
    .get("message")
    .values()
    .next()
    .value({ kind: "subscribe", id: "s1", topic: "files.changed", key: "/project" });
  eventServer.emit("files.changed", "/project", { event: "change", path: "/project/a" });

  assert.equal(eventCloseCalls, 1);
  assert.equal(eventListeners.get("message").size, 0);
  assert.equal(eventListeners.get("close").size, 0);
});
