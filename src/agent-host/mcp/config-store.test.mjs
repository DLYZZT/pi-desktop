import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpConfigStore, SAVED_MCP_SECRET, mcpToolExposure } = await importTestBundle("mcp-config-store", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "config-store.ts")],
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
  await store.upsert("project", project, "same", { command: "project" }, "missing");
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
