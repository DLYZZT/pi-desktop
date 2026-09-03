import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import nodeTest from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
// Herdr integration is intentionally macOS/Linux-only until the Windows transport is implemented.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
let modulePromise;

async function loadSocketClient() {
  modulePromise ??= importTestBundle("src/agent-host/herdr/socket-client", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/socket-client.ts"],
  });
  return modulePromise;
}

async function listen(t, onRequest) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-socket-"));
  const endpoint = path.join(directory, "herdr.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      onRequest(socket, request);
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  chmodSync(endpoint, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  });
  return { endpoint, server };
}

test("socket client correlates protocol 20 requests and maps blocked Agent errors", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, (socket, request) => {
    if (request.method === "ping") {
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong", version: "0.8.2", protocol: 20 } })}\n`);
    } else {
      socket.end(
        `${JSON.stringify({ id: request.id, error: { code: "agent_blocked", message: "approval required" } })}\n`,
      );
    }
  });
  const client = new HerdrSocketClient(endpoint);
  await client.assertSafeEndpoint();
  assert.deepEqual(await client.request({ method: "ping", params: {} }), {
    type: "pong",
    version: "0.8.2",
    protocol: 20,
  });
  await assert.rejects(
    client.request({ method: "agent.prompt", params: { target: "w1:p1", text: "hello" } }),
    (error) => error.code === "HERDR_AGENT_BLOCKED" && error.message === "The Herdr agent is blocked.",
  );
});

test("socket client uses process-monotonic request ids", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const ids = [];
  const { endpoint } = await listen(t, (socket, request) => {
    ids.push(request.id);
    socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`);
  });
  const client = new HerdrSocketClient(endpoint);
  await client.request({ method: "ping", params: {} });
  await client.request({ method: "ping", params: {} });
  const sequences = ids.map((id) => Number(String(id).split(":").at(-1)));
  assert.match(ids[0], /^pi-desktop:request:\d+$/);
  assert.equal(sequences[1], sequences[0] + 1);
});

test("socket client maps unavailable Agent explanations to a stable not-ready error", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, (socket, request) => {
    socket.end(
      `${JSON.stringify({
        id: request.id,
        error: { code: "agent_explain_unavailable", message: "raw upstream details" },
      })}\n`,
    );
  });
  await assert.rejects(
    new HerdrSocketClient(endpoint).request({ method: "agent.explain", params: { target: "pane-a" } }),
    (error) => error.code === "HERDR_AGENT_NOT_READY" && !error.message.includes("raw upstream"),
  );
});

test("socket client distinguishes request timeout from cancellation", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, () => {});
  const client = new HerdrSocketClient(endpoint);
  await assert.rejects(
    client.request({ method: "ping", params: {}, timeoutMs: 20 }),
    (error) => error.code === "HERDR_REQUEST_TIMEOUT" && error.retryable === true,
  );

  const controller = new globalThis.AbortController();
  const request = client.request({ method: "ping", params: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (error) => error.code === "HERDR_REQUEST_CANCELLED" && error.retryable === false);
});

test("socket client rejects responses larger than 4 MiB", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, (socket) => {
    socket.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  });
  await assert.rejects(
    new HerdrSocketClient(endpoint).request({ method: "ping", params: {} }),
    (error) => error.code === "HERDR_PROTOCOL_LIMIT_EXCEEDED",
  );
});

test("socket client rejects group-accessible endpoints before connecting", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, () => {});
  chmodSync(endpoint, 0o660);
  await assert.rejects(
    new HerdrSocketClient(endpoint).assertSafeEndpoint(),
    (error) => error.code === "HERDR_ENDPOINT_UNSAFE",
  );
});

test("socket client rejects an endpoint owned by another user", { skip: process.platform === "win32" }, async () => {
  const { HerdrSocketClient } = await importTestBundle("src/agent-host/herdr/socket-client-owner-mismatch", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/agent-host/herdr/socket-client.ts"],
    plugins: [
      {
        name: "owner-mismatch-lstat",
        setup(build) {
          build.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
            path: "owner-mismatch-lstat",
            namespace: "owner-mismatch-lstat",
          }));
          build.onLoad({ filter: /.*/, namespace: "owner-mismatch-lstat" }, () => ({
            contents: `export async function lstat() {
                return {
                  dev: 1n,
                  ino: 2n,
                  mode: 0o600n,
                  uid: BigInt(process.getuid()) + 1n,
                  isSocket: () => true,
                  isSymbolicLink: () => false,
                };
              }`,
            loader: "js",
          }));
        },
      },
    ],
  });
  await assert.rejects(
    new HerdrSocketClient("/private/herdr-owner-mismatch.sock").assertSafeEndpoint(),
    (error) => error.code === "HERDR_ENDPOINT_UNSAFE",
  );
});

test("socket client rejects symbolic-link endpoints and revalidates before every request", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  let requests = 0;
  const { endpoint } = await listen(t, () => {
    requests += 1;
  });
  const linkedEndpoint = path.join(path.dirname(endpoint), "linked.sock");
  symlinkSync(endpoint, linkedEndpoint);
  await assert.rejects(
    new HerdrSocketClient(linkedEndpoint).assertSafeEndpoint(),
    (error) => error.code === "HERDR_ENDPOINT_UNSAFE",
  );

  const client = new HerdrSocketClient(endpoint);
  await client.assertSafeEndpoint();
  chmodSync(endpoint, 0o660);
  await assert.rejects(
    client.request({ method: "ping", params: {} }),
    (error) => error.code === "HERDR_ENDPOINT_UNSAFE",
  );
  assert.equal(requests, 0);
});

test("event subscription accepts the start response then forwards event envelopes", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const { endpoint } = await listen(t, (socket, request) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    socket.write(`${JSON.stringify({ type: "event", event: { type: "pane.updated", pane_id: "w1:p1" } })}\n`);
  });
  const client = new HerdrSocketClient(endpoint);
  const event = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("event timeout")), 1_000);
    const stop = client.subscribe(
      ["pane.updated"],
      (value) => {
        clearTimeout(timer);
        stop();
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error ?? new Error("event stream closed"));
      },
    );
  });
  assert.deepEqual(event, { type: "event", event: { type: "pane.updated", pane_id: "w1:p1" } });
});

test("event subscription rejects an invalid handshake and ignores non-allowlisted events", async (t) => {
  const { HerdrSocketClient } = await loadSocketClient();
  const invalid = await listen(t, (socket, request) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "unexpected" } })}\n`);
  });
  await new Promise((resolve, reject) => {
    new HerdrSocketClient(invalid.endpoint).subscribe(
      ["pane.updated"],
      () => reject(new Error("invalid subscription forwarded an event")),
      (error) => {
        try {
          assert.equal(error?.code, "HERDR_SCHEMA_INVALID");
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      },
    );
  });

  const valid = await listen(t, (socket, request) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    socket.write(`${JSON.stringify({ type: "event", event: { type: "unknown.event" } })}\n`);
    socket.write(`${JSON.stringify({ type: "event", event: { type: "pane.updated", pane_id: "w1:p1" } })}\n`);
  });
  const received = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("allowlisted event timeout")), 1_000);
    const stop = new HerdrSocketClient(valid.endpoint).subscribe(
      ["pane.updated"],
      (event) => {
        received.push(event);
        clearTimeout(timer);
        stop();
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error ?? new Error("event stream closed"));
      },
    );
  });
  assert.deepEqual(received, [{ type: "event", event: { type: "pane.updated", pane_id: "w1:p1" } }]);
});
