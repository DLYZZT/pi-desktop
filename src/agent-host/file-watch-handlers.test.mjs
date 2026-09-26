import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { createFileHandlers, createRpcServer, createRpcClient, RpcError } = await importTestBundle(
  "file-watch-handlers",
  {
    packages: "external",
    stdin: {
      contents:
        'export {createFileHandlers} from "./handlers/files.ts"; export {createRpcServer,createRpcClient} from "../contract/rpc.ts"; export {RpcError} from "../contract/types.ts";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  },
);

function fixture(t, acquire) {
  const acquisitions = [];
  const server = createRpcServer();
  const handlers = createFileHandlers({
    async start(path, sourceSessionId) {
      const lease = { path, sourceSessionId, released: 0 };
      acquisitions.push(lease);
      await acquire?.(lease, acquisitions.length);
      return () => lease.released++;
    },
    stop() {
      throw new Error("RPC watches must release their own lease");
    },
  });
  server.handle({ "files.watchStart": handlers.startWatch, "files.watchStop": handlers.stopWatch });
  const clients = [];
  const connect = () => {
    const { port1, port2 } = new MessageChannel();
    server.attachPort(port1);
    const client = createRpcClient(port2);
    clients.push({ client, port: port1 });
    return { client, detach: () => server.detachPort(port1) };
  };
  t.after(() => {
    for (const { client, port } of clients) {
      client.close();
      server.detachPort(port);
    }
  });
  return { acquisitions, connect };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("independent watches of one path retain separate RPC leases and authorization contexts", async (t) => {
  const f = fixture(t);
  const { client } = f.connect();
  await client.call("files.watchStart", { path: "/fixture", watchId: "first", sourceSessionId: "session-one" });
  await client.call("files.watchStart", { path: "/fixture", watchId: "second", sourceSessionId: "session-two" });
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [0, 0],
  );
  assert.deepEqual(
    f.acquisitions.map((a) => a.sourceSessionId),
    ["session-one", "session-two"],
  );
  await client.call("files.watchStop", { path: "/fixture", watchId: "first" });
  await client.call("files.watchStop", { path: "/fixture", watchId: "first" });
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [1, 0],
  );
  await client.call("files.watchStop", { path: "/fixture", watchId: "second" });
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [1, 1],
  );
});

test("stop during watch installation releases the resource when it arrives instead of reviving the watch", async (t) => {
  const ready = createDeferred(),
    entered = createDeferred();
  const f = fixture(t, async () => {
    entered.resolve();
    await ready.promise;
  });
  const { client } = f.connect();
  const start = client.call("files.watchStart", { path: "/fixture", watchId: "pending" });
  await entered.promise;
  await client.call("files.watchStop", { path: "/fixture", watchId: "pending" });
  ready.resolve();
  await start;
  assert.equal(f.acquisitions[0].released, 1);
});

test("failure of a replaced start cannot release a newer start using the same watch id", async (t) => {
  const ready = createDeferred(),
    entered = createDeferred();
  const f = fixture(t, async (_lease, index) => {
    if (index === 1) {
      entered.resolve();
      await ready.promise;
    }
  });
  const { client } = f.connect();
  const first = client.call("files.watchStart", { path: "/fixture", watchId: "same" });
  const rejected = assert.rejects(first, (error) => error.code === "FORBIDDEN");
  await entered.promise;
  await client.call("files.watchStart", { path: "/fixture", watchId: "same" });
  ready.reject(new RpcError({ code: "FORBIDDEN", message: "Old authorization failed" }));
  await rejected;
  assert.equal(f.acquisitions[1].released, 0);
  await client.call("files.watchStop", { path: "/fixture", watchId: "same" });
  assert.equal(f.acquisitions[1].released, 1);
});

test("watch ids are isolated by RPC connection and legacy path leases cannot stop identified watches", async (t) => {
  const f = fixture(t),
    a = f.connect(),
    b = f.connect();
  await a.client.call("files.watchStart", { path: "/fixture", watchId: "same" });
  await b.client.call("files.watchStart", { path: "/fixture", watchId: "same" });
  await a.client.call("files.watchStart", { path: "/fixture" });
  await a.client.call("files.watchStop", { path: "/fixture" });
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [0, 0, 1],
  );
  a.detach();
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [1, 0, 1],
  );
  b.detach();
  assert.deepEqual(
    f.acquisitions.map((a) => a.released),
    [1, 1, 1],
  );
});

test("invalid watch ids never acquire a resource", async (t) => {
  const f = fixture(t);
  const { client } = f.connect();
  await assert.rejects(
    client.call("files.watchStart", { path: "/fixture", watchId: "bad:id" }),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.equal(f.acquisitions.length, 0);
});

test("disconnect during installation releases the late watch", async (t) => {
  const ready = createDeferred(),
    entered = createDeferred();
  const f = fixture(t, async () => {
    entered.resolve();
    await ready.promise;
  });
  const { client, detach } = f.connect();
  const start = client.call("files.watchStart", { path: "/fixture", watchId: "valid" });
  const closed = assert.rejects(start, (error) => error.code === "CLOSED");
  await entered.promise;
  detach();
  client.close();
  ready.resolve();
  await closed;
  await nextTurn();
  assert.equal(f.acquisitions[0].released, 1);
});
