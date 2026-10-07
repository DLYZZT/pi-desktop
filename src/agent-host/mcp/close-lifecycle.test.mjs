import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { importTestBundle } from "#test-bundle";
const { McpConnection, ContainedMcpStdioTransport } = await importTestBundle("mcp-close-lifecycle", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export {McpConnection} from "./connection.ts"; export {ContainedMcpStdioTransport} from "./stdio-transport.ts";',
  },
});
const snapshot = (cwd) => ({
  name: "fixture",
  sessionId: "fixture",
  cwd,
  source: "fixture",
  scope: "global",
  revision: "one",
  generation: 1,
  state: "not-started",
  observedAt: 0,
  toolCount: 0,
});
async function until(read) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error("lifecycle fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real HTTP initialization is aborted and settled before connection close completes", async (t) => {
  const received = createDeferred(),
    closed = createDeferred();
  const server = createServer((request, response) => {
    void (async () => {
      for await (const chunk of request) {
        void chunk;
      }
      response.on("close", () => closed.resolve());
      received.resolve();
    })().catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const connection = new McpConnection({
    snapshot: snapshot(process.cwd()),
    config: {
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      timeout: 60,
      headers: { Authorization: "Bearer fixture" },
    },
    trusted: true,
    changed() {},
  });
  const opening = connection.start();
  await received.promise;
  await connection.close();
  await opening;
  await Promise.race([
    closed.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP socket did not close")), 2000);
      timer.unref();
    }),
  ]);
  assert.equal(connection.snapshot.state, "disconnected");
});

test("closing provider-auth initialization waits for the started token operation and sends no late request", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const started = createDeferred(),
    release = createDeferred();
  const connection = new McpConnection({
    snapshot: snapshot(process.cwd()),
    config: { url: `http://127.0.0.1:${server.address().port}/mcp`, auth: { provider: "fixture" } },
    trusted: true,
    changed() {},
    providerToken: async () => {
      started.resolve();
      await release.promise;
      return "FRESH_FIXTURE_TOKEN";
    },
  });
  const opening = connection.start();
  await started.promise;
  let finished = false;
  const closing = connection.close().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release.resolve();
  await Promise.all([opening, closing]);
  assert.equal(requests, 0);
  assert.equal(connection.snapshot.state, "disconnected");
});

test(
  "real contained stdio is reaped when closed during initialization",
  { skip: process.platform === "win32" ? "Native Windows Job covered by Windows acceptance" : false },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-close-stdio-")),
      file = path.join(root, "server.mjs"),
      marker = path.join(root, "initialize");
    writeFileSync(
      file,
      `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.method==='initialize')writeFileSync(${JSON.stringify(marker)},'ready');}`,
    );
    const registered = [],
      removed = [];
    const context = {
      inventoryRevision: 1,
      resolutionId: "fixture",
      nativeEnv: { PATH: process.env.PATH },
      shellEnv: { PATH: process.env.PATH },
      commands: {},
      summary: [],
    };
    const transport = new ContainedMcpStdioTransport({
      config: { command: process.execPath, args: [file] },
      cwd: root,
      trusted: true,
      env: {},
      onStderr() {},
      runtime: {
        createExecutionContext: async () => context,
        requireFromContext: () => ({ executable: "/bin/bash", argvPrefix: [], cwdSemantics: "native" }),
      },
      workerEntryPath: path.join(import.meta.dirname, "../managed-process/worker.ts"),
      workerExecArgv: ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      parentCall: async (method, params) => {
        if (method === "managedProcesses.getSettings") return { reaperReady: true, capability: { ready: true } };
        if (method === "managedProcesses.register") {
          registered.push(params.record);
          return { journalRevision: 1 };
        }
        if (method === "managedProcesses.unregister") {
          removed.push(params);
          return { ok: true };
        }
        throw new Error(method);
      },
    });
    const connection = new McpConnection({
      snapshot: snapshot(root),
      config: { command: process.execPath },
      trusted: true,
      changed() {},
      createTransport: () => transport,
    });
    t.after(async () => {
      await connection.close();
      rmSync(root, { recursive: true, force: true });
    });
    const opening = connection.start();
    await until(() => existsSync(marker));
    await connection.close();
    await opening;
    assert.equal(registered.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].nonce, registered[0].nonce);
    assert.equal(connection.snapshot.state, "disconnected");
  },
);
