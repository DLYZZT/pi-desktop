import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import { createRpcClient, createRpcServer } from "./rpc.ts";
import { RpcError } from "./types.ts";

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
