import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { importTestBundle } from "#test-bundle";
const { McpService } = await importTestBundle("mcp-service", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "service.ts")],
});
async function waitFor(read) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error("MCP fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-session-")),
    definitions = new Map(),
    active = new Set(),
    servers = [];
  if (options.entryTools)
    for (const name of ["codemode", "tool_search"])
      definitions.set(name, { name, exposure: "direct", defaultActive: false });
  let running = false,
    empty = false,
    executed = 0;
  const service = new McpService(
    {
      changed() {},
      oauth: { updated() {} },
      connection: {
        createTransport: async () => {
          const { client, server } = createInMemoryTransportPair();
          servers.push(server);
          server.onMessage((request) => {
            if (request.id === undefined) return;
            let result;
            if (request.method === "initialize")
              result = {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              };
            else if (request.method === "tools/list")
              result = {
                tools: options.catalog ?? [
                  {
                    name: "echo",
                    description: "Fixture echo",
                    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                  },
                ],
              };
            else {
              executed++;
              result = {
                content: [{ type: "text", text: request.params.arguments.text }],
                structuredContent: { original: request.params.arguments.text },
              };
            }
            void server.send({ jsonrpc: "2.0", id: request.id, result });
          });
          await server.start();
          return client;
        },
      },
    },
    root,
  );
  t.after(async () => {
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const hooks = {
    isEmpty: () => empty,
    isRunning: () => running,
    isAllowed: () => false,
    ctx: { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session" } },
    pi: {
      getMcpServers: () => options.registered ?? [],
      getSettings: () => options.settings ?? {},
      getAllTools: () => [...definitions.values()],
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active.clear();
        names.forEach((name) => active.add(name));
      },
      registerTool: (tool) => {
        definitions.set(tool.name, tool);
        if (tool.exposure === "hidden") active.delete(tool.name);
        else if (tool.defaultActive) active.add(tool.name);
      },
    },
  };
  if (options.declarations) hooks.declarations = () => options.declarations;
  hooks.setDeclarations = (names) => {
    options.declarations = names;
  };
  if (!options.noGlobal)
    await service.config.upsert(
      "global",
      undefined,
      "fixture",
      options.config ?? { command: "fixture", exposure: "direct" },
      "missing",
    );
  await service.attach(hooks);
  await waitFor(() => service.snapshot("session")[0]?.state === "connected");
  return {
    root,
    service,
    definitions,
    active,
    hooks,
    servers,
    setRunning: (value) => {
      running = value;
    },
    setEmpty: (value) => {
      empty = value;
    },
    get executed() {
      return executed;
    },
  };
}

test("Desktop MCP registrations expose real state and keep stable names across queued reconnects", async (t) => {
  const f = await fixture(t),
    tool = f.service.tools("session")[0],
    original = f.definitions.get(tool.name);
  assert.equal(tool.active, true);
  assert.equal(tool.callable, true);
  assert.equal(tool.executionAllowed, false);
  const result = await original.execute("call", { text: "ORIGINAL_MCP_RESULT" });
  assert.equal(result.structuredContent.structuredContent.original, "ORIGINAL_MCP_RESULT");
  const generation = f.service.snapshot("session")[0].generation;
  f.setRunning(true);
  await f.service.reconnect("session", "fixture");
  assert.equal(f.service.snapshot("session")[0].pendingApply, true);
  assert.equal(f.service.snapshot("session")[0].generation, generation);
  f.setRunning(false);
  await f.service.reconcile("session");
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  assert.ok(f.service.snapshot("session")[0].generation > generation);
  assert.equal(f.service.tools("session")[0].name, tool.name);
  await assert.rejects(original.execute("stale", { text: "DO_NOT_EXECUTE" }), /generation/);
  assert.equal(f.executed, 1);
});

for (const exposure of ["direct", "deferred", "codemode", "codemode-deferred", "hidden"])
  test(`MCP ${exposure} exposure declares only the appropriate model entry point`, async (t) => {
    const f = await fixture(t, { config: { command: "fixture", exposure }, entryTools: true });
    assert.equal(f.active.has("mcp__fixture__echo"), exposure === "direct");
    assert.equal(f.active.has("codemode"), exposure === "codemode" || exposure === "codemode-deferred");
    assert.equal(f.active.has("tool_search"), exposure === "deferred");
    assert.equal(f.service.tools("session").length, exposure === "hidden" ? 0 : 1);
    assert.equal(
      f.definitions.get("mcp__fixture__echo").exposure,
      exposure === "codemode-deferred" ? "deferred" : exposure,
    );
  });

test("MCP caller activation respects shared negative defaults and persisted manual declarations", async (t) => {
  const f = await fixture(t, {
    config: { command: "fixture", exposure: "codemode" },
    entryTools: true,
    settings: { defaultTools: ["-codemode", "-tool_search"] },
  });
  assert.equal(f.active.has("codemode"), false);
  f.service.declare("session", ["codemode"]);
  assert.equal(f.active.has("codemode"), true);
  f.service.declare("session", []);
  await f.service.reconnect("session", "fixture");
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  assert.equal(f.active.has("codemode"), false);
  await f.service.detach("session");
  await f.service.attach(f.hooks);
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  assert.equal(f.active.has("codemode"), false);
});

test("file MCP servers override extension registrations and removal restores the extension without duplicate instances", async (t) => {
  const f = await fixture(t, {
    registered: [
      { name: "fixture", extensionPath: "builtin:fixture", config: { command: "extension", exposure: "deferred" } },
    ],
  });
  assert.equal(f.service.snapshot("session").length, 1);
  assert.equal(f.service.snapshot("session")[0].scope, "global");
  const config = await f.service.config.snapshot("global");
  await f.service.config.remove("global", undefined, "fixture", config.revision);
  await f.service.changed("global");
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  assert.equal(f.service.snapshot("session").length, 1);
  assert.equal(f.service.snapshot("session")[0].scope, "extension");
  assert.equal(f.service.getConnection("session", "fixture").config.command, "extension");
  assert.equal(f.service.extensionEntries("session")[0].source, "builtin:fixture");
  const extension = f.service.extensionEntries("session")[0];
  await f.service.updateExtension("session", "fixture", { ...extension.config, timeout: 2 }, extension.revision);
  await assert.rejects(
    f.service.updateExtension("session", "fixture", extension.config, extension.revision),
    (error) => error.code === "CONFLICT",
  );
});

test("MCP catalog removal withdraws the missing tool and hides its old generation", async (t) => {
  const options = { catalog: [{ name: "old", inputSchema: { type: "object" } }] };
  const f = await fixture(t, options),
    original = f.definitions.get("mcp__fixture__old");
  options.catalog = [{ name: "new", inputSchema: { type: "object" } }];
  await f.servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await waitFor(() => f.service.tools("session")[0]?.originalName === "new");
  assert.equal(f.active.has("mcp__fixture__old"), false);
  assert.equal(f.definitions.get("mcp__fixture__old").exposure, "hidden");
  await assert.rejects(original.execute("stale", {}), /generation/);
  assert.equal(f.executed, 0);
});

test("MCP first-use approval coalesces concurrent requests and grants only the selected server", async (t) => {
  const f = await fixture(t, { entryTools: true }),
    grants = new Set();
  f.hooks.isAllowed = (name) => grants.has(name);
  f.hooks.setGrants = (names) => {
    grants.clear();
    names.forEach((name) => grants.add(name));
  };
  let finish,
    prompts = 0,
    copy;
  const ctx = {
    hasUI: true,
    ui: {
      confirmLocalized: async (_title, _message, localization) => {
        prompts++;
        copy = localization;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  const first = f.service.requestAuthorization("session", "mcp__fixture__echo", {}, ctx);
  const second = f.service.requestAuthorization("session", "mcp__fixture__echo", {}, ctx);
  await waitFor(() => prompts === 1);
  assert.equal(copy.id, "mcp.authorize");
  assert.equal(copy.servers, "fixture");
  assert.match(copy.tools, /echo/);
  finish(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.ok(grants.has("mcp__fixture__echo"));
  assert.ok(grants.has("codemode"));
  assert.equal(await f.service.requestAuthorization("session", "mcp__fixture__echo", {}, ctx), true);
  assert.equal(prompts, 1);
});

test("MCP denied requests stay blocked for a run and stale reconnect approval never grants access", async (t) => {
  const f = await fixture(t),
    grants = new Set();
  f.hooks.isAllowed = (name) => grants.has(name);
  f.hooks.setGrants = (names) => names.forEach((name) => grants.add(name));
  let prompts = 0;
  const denied = {
    hasUI: true,
    ui: {
      confirm: async () => {
        prompts++;
        return false;
      },
    },
  };
  assert.equal(await f.service.requestAuthorization("session", "mcp__fixture__echo", {}, denied), false);
  assert.equal(await f.service.requestAuthorization("session", "mcp__fixture__echo", {}, denied), false);
  assert.equal(prompts, 1);
  f.service.resetPermissionRequests("session");
  let finish;
  const pending = f.service.requestAuthorization(
    "session",
    "mcp__fixture__echo",
    {},
    {
      hasUI: true,
      ui: {
        confirm: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
  );
  await waitFor(() => Boolean(finish));
  await f.service.reconnect("session", "fixture");
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  finish(true);
  assert.equal(await pending, false);
  assert.equal(grants.size, 0);
});

test("MCP pending approval cannot cross source changes, revocation or a cancelled run", async (t) => {
  const f = await fixture(t),
    grants = new Set();
  f.hooks.setGrants = (names) => names.forEach((name) => grants.add(name));
  let finish,
    valid = true;
  const pending = f.service.requestAuthorization(
    "session",
    "mcp__fixture__echo",
    {},
    {
      hasUI: true,
      ui: {
        confirm: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
    () => valid,
  );
  await waitFor(() => Boolean(finish));
  valid = false;
  finish(true);
  assert.equal(await pending, false);
  assert.equal(grants.size, 0);
  f.service.resetPermissionRequests("session");
  const revoked = f.service.requestAuthorization(
    "session",
    "mcp__fixture__echo",
    {},
    {
      hasUI: true,
      ui: {
        confirm: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
  );
  await waitFor(() => Boolean(finish));
  f.service.grant("session", []);
  finish(true);
  assert.equal(await revoked, false);
  assert.equal(grants.size, 0);
  f.service.resetPermissionRequests("session");
  const controller = new globalThis.AbortController();
  const cancelled = f.service.requestAuthorization(
    "session",
    "mcp__fixture__echo",
    {},
    {
      hasUI: true,
      signal: controller.signal,
      ui: {
        confirm: (_title, _message, { signal }) =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })),
      },
    },
  );
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(grants.size, 0);
  assert.equal(await f.service.requestAuthorization("session", "mcp__fixture__echo", {}, { hasUI: false }), false);
});

test("disabling a server revokes its generation immediately even while a prompt is running", async (t) => {
  const f = await fixture(t),
    name = f.service.tools("session")[0].name,
    original = f.definitions.get(name);
  f.setRunning(true);
  const config = await f.service.config.snapshot("global");
  await f.service.config.upsert(
    "global",
    undefined,
    "fixture",
    { command: "fixture", enabled: false },
    config.revision,
  );
  await f.service.changed("global");
  assert.equal(f.service.snapshot("session")[0].state, "disabled");
  assert.equal(f.active.has(name), false);
  assert.equal(f.definitions.get(name).exposure, "hidden");
  await assert.rejects(original.execute("stale", { text: "DO_NOT_EXECUTE" }), /generation/);
  assert.equal(f.executed, 0);
});

test("MCP connection catalogs cannot activate tools in Desktop's empty-tool mode", async (t) => {
  const f = await fixture(t);
  f.setEmpty(true);
  await f.service.reconnect("session", "fixture");
  await waitFor(() => f.service.snapshot("session")[0]?.state === "connected");
  assert.equal(f.active.size, 0);
  assert.equal(f.service.tools("session")[0].active, false);
});
