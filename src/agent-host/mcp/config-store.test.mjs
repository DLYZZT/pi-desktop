import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpConfigStore, SAVED_MCP_SECRET, mcpToolExposure, validateMcpConfig } = await importTestBundle(
  "mcp-config-store",
  {
    packages: "external",
    entryPoints: [path.join(import.meta.dirname, "config-store.ts")],
  },
);

test("MCP OAuth and provider authentication reject unsafe or contradictory configuration", () => {
  const url = "https://mcp.example.invalid";
  for (const oauth of [
    { clientName: " " },
    { authServerMetadataUrl: "http://external.invalid/metadata" },
    { authServerMetadataUrl: "https://user:secret@example.invalid/metadata" },
    { authServerMetadataUrl: 42 },
    { clientRegistration: "unknown" },
    { clientRegistration: "cimd", clientId: "conflict" },
    { clientRegistration: "cimd", clientName: "conflict" },
    { clientRegistration: "cimd", callbackUrl: "http://localhost/other" },
    { clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" },
  ])
    assert.throws(
      () => validateMcpConfig("fixture", { url, oauth }),
      (error) => error.code === "BAD_REQUEST",
    );
  assert.throws(
    () => validateMcpConfig("fixture", { url, auth: { provider: "radius" } }, "project"),
    /only allowed in global/,
  );
  assert.throws(
    () => validateMcpConfig("fixture", { url: "http://remote.invalid", auth: { provider: "radius" } }, "global"),
    /HTTPS/,
  );
  assert.doesNotThrow(() =>
    validateMcpConfig(
      "fixture",
      { url, oauth: { clientRegistration: "cimd", authServerMetadataUrl: "https://auth.example.invalid/metadata" } },
      "global",
    ),
  );
  assert.doesNotThrow(() =>
    validateMcpConfig("fixture", { url: "http://127.0.0.1:1234", auth: { provider: "radius" } }, "extension"),
  );
});

test("normalization collisions cannot be written or used to share one credential identity", async (t) => {
  const { store, project } = fixture(t);
  const initial = await store.upsert(
    "global",
    undefined,
    "my-server",
    { url: "https://mcp.example.invalid" },
    "missing",
  );
  await assert.rejects(
    store.upsert("global", undefined, "my_server", { url: "https://mcp.example.invalid" }, initial.revision),
    /names conflict/,
  );
  assert.equal((await store.snapshot("global")).revision, initial.revision);
  await assert.rejects(
    store.upsert(
      "project",
      project,
      "my_server",
      { url: "https://mcp.example.invalid" },
      (await store.snapshot("project", project)).revision,
    ),
    /names conflict/,
  );
  // External CLI writes are also validated before any connections can be launched.
  mkdirSync(path.dirname(store.filename("project", project)), { recursive: true });
  writeFileSync(
    store.filename("project", project),
    JSON.stringify({ mcpServers: { my_server: { command: "fixture" } } }),
  );
  const loaded = await store.effective(project, true);
  assert.deepEqual(loaded.servers, []);
  assert.match(loaded.errors[0], /names conflict/);
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-config-")),
    project = path.join(root, "project");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, store: new McpConfigStore(path.join(root, "agent")) };
}

test("MCP configuration writes preserve unknown fields and refuse stale CLI revisions", async (t) => {
  const { store } = fixture(t),
    file = store.filename("global");
  mkdirSync(path.dirname(file));
  writeFileSync(
    file,
    JSON.stringify({
      future: { untouched: true },
      autoEnableCodemode: false,
      mcpServers: { old: { command: "old", futureServer: 42 } },
    }),
  );
  const first = await store.snapshot("global");
  const saved = await store.upsert(
    "global",
    undefined,
    "new",
    { command: "node", args: ["server.js"] },
    first.revision,
  );
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.future.untouched, true);
  assert.equal(raw.mcpServers.old.futureServer, 42);
  assert.equal(raw.autoEnableCodemode, false);
  writeFileSync(file, JSON.stringify({ ...raw, cliWritten: true }));
  await assert.rejects(store.remove("global", undefined, "old", saved.revision), (error) => error.code === "CONFLICT");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cliWritten, true);
});

test("project overrides apply only after trust and viewing or preflighting never executes secret commands", async (t) => {
  const { store, root, project } = fixture(t),
    marker = path.join(root, "MUST_NOT_EXIST");
  await store.upsert(
    "global",
    undefined,
    "same",
    { command: "global", headers: { Authorization: `!touch ${marker}` } },
    "missing",
  );
  await store.upsert(
    "project",
    project,
    "same",
    { command: "project" },
    (await store.snapshot("project", project)).revision,
  );
  assert.equal((await store.effective(project, false)).servers[0].config.command, "global");
  assert.equal((await store.effective(project, true)).servers[0].config.command, "project");
  const snapshot = await store.snapshot("global");
  assert.equal(snapshot.entries[0].config.headers.Authorization, SAVED_MCP_SECRET);
  assert.deepEqual(
    (
      await store.preflight(
        "global",
        undefined,
        JSON.stringify({ mcpServers: { same: { url: "https://example.invalid/mcp" } } }),
      )
    ).conflicts,
    ["same"],
  );
  assert.equal(existsSync(marker), false);
});

test("saved secret placeholders round-trip while explicit replacement and deletion remain possible", async (t) => {
  const { store } = fixture(t);
  await store.upsert(
    "global",
    undefined,
    "remote",
    {
      url: "https://example.invalid/mcp",
      headers: { Authorization: "ORIGINAL_SECRET", Reference: "${TOKEN}" },
      oauth: { clientSecret: "CLIENT_SECRET" },
    },
    "missing",
  );
  const masked = await store.snapshot("global");
  assert.doesNotMatch(JSON.stringify(masked), /ORIGINAL_SECRET|CLIENT_SECRET/);
  assert.equal(masked.entries[0].config.headers.Reference, "${TOKEN}");
  const next = await store.upsert(
    "global",
    undefined,
    "remote",
    { ...masked.entries[0].config, timeout: 10 },
    masked.revision,
  );
  assert.equal(
    JSON.parse(readFileSync(store.filename("global"), "utf8")).mcpServers.remote.headers.Authorization,
    "ORIGINAL_SECRET",
  );
  const imported = await store.import(
    "global",
    undefined,
    JSON.stringify({ mcpServers: { remote: next.entries[0].config } }),
    next.revision,
  );
  await store.upsert(
    "global",
    undefined,
    "remote",
    { url: "https://example.invalid/mcp", headers: { Authorization: "REPLACED" } },
    imported.revision,
  );
  const raw = JSON.parse(readFileSync(store.filename("global"), "utf8"));
  assert.equal(raw.mcpServers.remote.headers.Authorization, "REPLACED");
  assert.equal(raw.mcpServers.remote.oauth, undefined);
});

test("invalid imports and malformed existing files never overwrite the original config", async (t) => {
  const { store } = fixture(t),
    file = store.filename("global");
  for (const config of [
    { type: "sse", url: "https://example.invalid" },
    { url: "javascript:alert(1)" },
    { command: "node", args: "--wrong" },
    { url: "https://example.invalid", oauth: { callbackUrl: "https://example.invalid/callback" } },
  ])
    await assert.rejects(
      store.upsert("global", undefined, "bad", config, "missing"),
      (error) => error.code === "BAD_REQUEST",
    );
  assert.equal(existsSync(file), false);
  mkdirSync(path.dirname(file));
  writeFileSync(file, "{corrupted");
  assert.equal((await store.snapshot("global")).revision, "invalid");
  await assert.rejects(store.upsert("global", undefined, "good", { command: "node" }, "missing"));
  assert.equal(readFileSync(file, "utf8"), "{corrupted");
});

test("MCP exposure follows exact-name precedence and first wildcard match", () => {
  const config = {
    exposure: "codemode",
    toolExposure: { "read_*": "deferred", read_special: "direct", "*": "hidden" },
  };
  assert.equal(mcpToolExposure(config, "read_special"), "direct");
  assert.equal(mcpToolExposure(config, "read_other"), "deferred");
  assert.equal(mcpToolExposure(config, "write"), "hidden");
});

test("a missing revision cannot overwrite a file concurrently created as an empty object", async (t) => {
  const { store } = fixture(t),
    file = store.filename("global");
  mkdirSync(path.dirname(file));
  writeFileSync(file, "{}");
  await assert.rejects(
    store.upsert("global", undefined, "new", { command: "node" }, "missing"),
    (error) => error.code === "CONFLICT",
  );
});

test("project-only policy overrides inherit global transport and credentials without copying them", async (t) => {
  const { store, project } = fixture(t);
  const global = await store.upsert(
    "global",
    undefined,
    "remote",
    {
      url: "https://mcp.example.invalid",
      headers: { Private: "GLOBAL_SECRET" },
      auth: { provider: "radius" },
      exposure: "direct",
      toolExposure: { read: "direct", write: "hidden" },
    },
    "missing",
  );
  const inherited = await store.snapshot("project", project);
  assert.equal(inherited.entries[0].scope, "global");
  assert.deepEqual(inherited.entries[0].projectOverride.config, {});
  assert.equal(inherited.entries[0].projectOverride.exists, false);
  assert.doesNotMatch(JSON.stringify(inherited), /GLOBAL_SECRET/);
  const saved = await store.upsert(
    "project",
    project,
    "remote",
    {
      enabled: false,
      exposure: "codemode",
      toolExposure: { read: "deferred" },
    },
    inherited.revision,
  );
  const raw = JSON.parse(readFileSync(store.filename("project", project), "utf8"));
  assert.deepEqual(raw.mcpServers.remote, { enabled: false, exposure: "codemode", toolExposure: { read: "deferred" } });
  const effective = (await store.effective(project, true)).servers[0];
  assert.equal(effective.scope, "global");
  assert.equal(effective.source, store.filename("global"));
  assert.equal(effective.overrideSource, store.filename("project", project));
  assert.equal(effective.config.headers.Private, "GLOBAL_SECRET");
  assert.equal(effective.config.auth.provider, "radius");
  assert.equal(effective.config.enabled, false);
  assert.deepEqual(effective.config.toolExposure, { read: "deferred" });
  assert.equal((await store.effective(project, false)).servers[0].config.enabled, undefined);
  assert.equal((await store.snapshot("global")).revision, global.revision);
  assert.equal(saved.entries[0].projectOverride.exists, true);
  await store.remove("project", project, "remote", saved.revision);
  assert.deepEqual((await store.effective(project, true)).servers[0].config, {
    url: "https://mcp.example.invalid",
    headers: { Private: "GLOBAL_SECRET" },
    auth: { provider: "radius" },
    exposure: "direct",
    toolExposure: { read: "direct", write: "hidden" },
  });
});

test("project import shares shallow override rules and rejects absent bases or credential edits", async (t) => {
  const { store, project } = fixture(t);
  await store.upsert(
    "global",
    undefined,
    "fixture",
    { command: "global", toolExposure: { read: "direct" } },
    "missing",
  );
  const revision = (await store.snapshot("project", project)).revision;
  for (const config of [
    { headers: { Authorization: "no" } },
    { auth: { provider: "radius" } },
    { timeout: 30 },
    { description: "changed" },
    { enabled: "false" },
    { toolExposure: { read: "bad" } },
  ]) {
    await assert.rejects(
      store.upsert("project", project, "fixture", config, revision),
      (error) => error.code === "BAD_REQUEST",
    );
    await assert.rejects(store.preflight("project", project, JSON.stringify({ mcpServers: { fixture: config } })));
  }
  await assert.rejects(
    store.upsert("project", project, "missing", { enabled: false }, revision),
    /requires a global server/,
  );
  const json = JSON.stringify({ mcpServers: { fixture: { toolExposure: {} } } });
  assert.deepEqual(await store.preflight("project", project, json), { entries: ["fixture"], conflicts: [] });
  await store.import("project", project, json, revision);
  assert.deepEqual((await store.effective(project, true)).servers[0].config.toolExposure, {});
});

test("editing inherited policy detects global changes and invalid policies cannot reenable global servers", async (t) => {
  const { store, project } = fixture(t);
  const global = await store.upsert("global", undefined, "fixture", { command: "one" }, "missing");
  const initial = await store.snapshot("project", project);
  await store.upsert("global", undefined, "fixture", { command: "two" }, global.revision);
  await assert.rejects(store.upsert("project", project, "fixture", { enabled: false }, initial.revision), /changed/);
  const saved = await store.upsert(
    "project",
    project,
    "fixture",
    { enabled: false },
    (await store.snapshot("project", project)).revision,
  );
  assert.equal(saved.entries[0].config.command, "two");
  writeFileSync(store.filename("project", project), JSON.stringify({ mcpServers: { fixture: { enabled: "false" } } }));
  const invalid = await store.effective(project, true);
  assert.deepEqual(invalid.servers, []);
  assert.match(invalid.errors[0], /enabled/);
  assert.equal((await store.effective(project, false)).servers[0].config.command, "two");
  assert.equal((await store.snapshot("project", project)).revision, "invalid");
});
