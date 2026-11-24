import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CODING_FULL_TOOLS, PRESET_FULL } from "../shared/tool-presets.ts";

const { DesktopSessionToolStore } = await importTestBundle("src/agent-host/session-tool-store", {
  packages: "external",
  stdin: {
    contents: 'export { DesktopSessionToolStore } from "./session-tool-store.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "session-tool-store-test-entry.ts",
    loader: "ts",
  },
});

test("the first ordinary permission writes after a killed lock holder wait without blocking and preserve order", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-killed-tool-writer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  store.set("existing", ["edit"]);
  const child = spawn(
    process.execPath,
    [
      "-e",
      'require("proper-lockfile").lockSync(process.argv[1],{realpath:false});process.send("locked");setInterval(()=>{},60000);',
      file,
    ],
    { cwd: import.meta.dirname, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => child.kill());
  assert.equal((await once(child, "message"))[0], "locked");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const first = store.set("new", ["read"]),
    revoke = store.set("new", []);
  await new Promise(setImmediate);
  assert.equal(store.get("new"), undefined);
  await Promise.all([first, revoke]);
  assert.deepEqual(store.get("new"), []);
  assert.deepEqual(store.get("existing"), ["edit"]);
});

test("an asynchronous recovery scan keeps other permission changes queued until its synchronous commit", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-permission-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DesktopSessionToolStore(path.join(directory, "permissions.json"));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const scan = store.writeLock.prepareThenRun(
    async () => {
      entered.resolve();
      await release.promise;
      return "checked";
    },
    (result) => {
      assert.equal(result, "checked");
      store.locked.set("session", ["read"]);
    },
  );
  await entered.promise;
  assert.equal(store.writeLock.isHeld, false);
  const later = store.set("session", []);
  assert.equal(store.get("session"), undefined);
  release.resolve();
  await Promise.all([scan, later]);
  assert.deepEqual(store.get("session"), []);
  await assert.rejects(
    store.writeLock.prepareThenRun(
      async () => {
        throw new Error("unavailable store");
      },
      () => assert.fail(),
    ),
    /unavailable store/,
  );
  await store.set("session", ["edit"]);
  assert.deepEqual(store.get("session"), ["edit"]);
});

test("a fork waits for a concurrent policy writer and preserves its latest grants and unknown fields", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-fork-grant-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  store.set("original", ["read"]);
  assert.deepEqual(store.get("original"), ["read"]);
  const release = lockfile.lockSync(file, { realpath: false });
  let published = false;
  const pending = store.publishChatOnlyFork("copy", undefined, () => {
    published = true;
  });
  try {
    assert.equal(published, false);
    const latest = JSON.parse(readFileSync(file));
    latest.sessions.original.toolNames = ["edit"];
    latest.sessions.original.extra = "written by another process";
    writeFileSync(file, JSON.stringify(latest));
  } finally {
    release();
  }
  await pending;
  assert.equal(published, true);
  assert.deepEqual(store.get("original"), ["edit"]);
  assert.deepEqual(store.get("copy"), []);
  const saved = JSON.parse(readFileSync(file));
  assert.equal(saved.sessions.original.extra, "written by another process");
});

test("general orchestration preferences preserve child grants and survive reopen and no-tools transitions", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-orchestration-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  store.set("fixture", PRESET_FULL);
  store.setExecution("fixture", ["protected_step"]);
  store.setMcpExecution("fixture", ["mcp__fixture__echo"]);
  store.setOrchestration("fixture", ["tool_search"]);
  const reopened = new DesktopSessionToolStore(file);
  assert.deepEqual(reopened.getOrchestration("fixture"), ["tool_search"]);
  assert.equal(reopened.get("fixture").includes("codemode"), false);
  assert.deepEqual(reopened.getExecution("fixture"), ["protected_step"]);
  assert.deepEqual(reopened.getMcpExecution("fixture"), ["mcp__fixture__echo"]);
  store.set("fixture", []);
  assert.deepEqual(store.getOrchestration("fixture"), []);
  store.set("fixture", PRESET_FULL);
  assert.deepEqual(store.getOrchestration("fixture"), ["codemode", "tool_search"]);
  assert.equal(store.getMcpExecution("fixture"), undefined);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("legacy full access includes orchestration unless old MCP declarations explicitly selected otherwise", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-orchestration-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        full: { toolNames: CODING_FULL_TOOLS },
        disabled: { toolNames: CODING_FULL_TOOLS, mcpDeclarationToolNames: [] },
        chosen: { toolNames: ["read"], mcpDeclarationToolNames: ["codemode", "read_mcp_resource"] },
      },
    }),
  );
  const store = new DesktopSessionToolStore(file);
  assert.deepEqual(store.get("full"), PRESET_FULL);
  assert.deepEqual(store.getOrchestration("disabled"), []);
  assert.deepEqual(store.getOrchestration("chosen"), ["codemode"]);
  store.setOrchestration("chosen", ["tool_search"]);
  assert.deepEqual(new DesktopSessionToolStore(file).getOrchestration("chosen"), ["tool_search"]);
  assert.deepEqual(store.getMcpDeclaration("chosen"), ["codemode", "read_mcp_resource"]);
});

test("MCP resource declarations preserve automatic and explicit general orchestration across reopen", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-resource-declarations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  store.set("automatic", ["read", "bash", "edit", "write"]);
  store.setMcpDeclaration("automatic", ["read_mcp_resource"]);
  assert.equal(store.getOrchestration("automatic"), undefined);
  store.set("automatic", ["read", "bash", "edit", "write"]);
  assert.equal(new DesktopSessionToolStore(file).getOrchestration("automatic"), undefined);
  store.set("manual", PRESET_FULL);
  store.setOrchestration("manual", ["tool_search"]);
  store.setMcpDeclaration("manual", []);
  assert.deepEqual(new DesktopSessionToolStore(file).getOrchestration("manual"), ["tool_search"]);
});

test("Desktop session tools persist outside Pi session JSONL with normalized defensive copies", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-session-tools-"));
  const filePath = path.join(directory, "session-tools.json");

  try {
    const store = new DesktopSessionToolStore(filePath);
    store.set(" session-one ", [" read ", "read", "bash"]);

    const first = store.get("session-one");
    assert.deepEqual(first, ["read", "bash"]);
    first.push("write");
    assert.deepEqual(store.get("session-one"), ["read", "bash"]);

    const reopened = new DesktopSessionToolStore(filePath);
    assert.deepEqual(reopened.get("session-one"), ["read", "bash"]);
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(persisted.version, 1);
    assert.deepEqual(persisted.sessions["session-one"].toolNames, ["read", "bash"]);
    assert.equal(Number.isNaN(Date.parse(persisted.sessions["session-one"].updatedAt)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Desktop session tool store tolerates a corrupt sidecar without touching Pi data", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-desktop-session-tools-corrupt-"));
  const filePath = path.join(directory, "session-tools.json");

  try {
    writeFileSync(filePath, "not-json", "utf8");
    const store = new DesktopSessionToolStore(filePath);
    assert.equal(store.get("missing"), undefined);
    store.set("session-two", []);
    assert.deepEqual(new DesktopSessionToolStore(filePath).get("session-two"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution grants are optional v1 metadata, survive reopen and ordinary selections, and close with no-tools", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-execution-grants-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "session-tools.json");
  const store = new DesktopSessionToolStore(filename, "darwin");
  store.set("fixture", ["read"]);
  assert.equal(store.getExecution("fixture"), undefined);
  store.setExecution("fixture", [" deferred ", "deferred", "powershell"]);
  const granted = store.getExecution("fixture");
  assert.deepEqual(granted, ["deferred"]);
  granted.push("other");
  assert.deepEqual(store.getExecution("fixture"), ["deferred"]);
  store.set("fixture", ["read", "write"]);
  assert.deepEqual(new DesktopSessionToolStore(filename, "darwin").getExecution("fixture"), ["deferred"]);
  store.set("fixture", []);
  assert.deepEqual(new DesktopSessionToolStore(filename, "darwin").getExecution("fixture"), []);
  store.set("fixture", ["read"]);
  assert.equal(new DesktopSessionToolStore(filename, "darwin").getExecution("fixture"), undefined);
  assert.equal(JSON.parse(readFileSync(filename)).version, 1);
});

test("MCP-specific grants preserve ordinary execution choices and are revoked by empty mode", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-grants-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  store.set("fixture", ["read"]);
  store.setExecution("fixture", ["ordinary"]);
  store.setMcpExecution("fixture", ["mcp__fixture__echo", "codemode"]);
  const reopened = new DesktopSessionToolStore(file);
  assert.deepEqual(reopened.getExecution("fixture"), ["ordinary"]);
  assert.deepEqual(reopened.getMcpExecution("fixture"), ["mcp__fixture__echo", "codemode"]);
  store.set("fixture", ["read", "write"]);
  assert.deepEqual(new DesktopSessionToolStore(file).getMcpExecution("fixture"), ["mcp__fixture__echo", "codemode"]);
  store.set("fixture", []);
  assert.deepEqual(new DesktopSessionToolStore(file).getMcpExecution("fixture"), []);
  store.set("fixture", ["read"]);
  assert.equal(new DesktopSessionToolStore(file).getMcpExecution("fixture"), undefined);
});

test("MCP migration rewrites only proven identities across grants and declarations, never merely sanitized strings", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-identities-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    old = "mcp__dev-server__read-file",
    next = "mcp__dev_server__read_file_aabbccdd";
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        fixture: {
          toolNames: ["read", old],
          executionToolNames: ["ordinary", old],
          mcpExecutionToolNames: [old, "mcp__dev_server__read_file"],
          mcpDeclarationToolNames: ["read_mcp_resource", old],
          updatedAt: "2026-10-01T00:00:00Z",
        },
      },
    }),
  );
  const store = new DesktopSessionToolStore(file);
  const raw = readFileSync(file, "utf8");
  store.get("fixture");
  assert.equal(readFileSync(file, "utf8"), raw, "a sidecar read alone never performs migration");
  const a = { name: next, server: "dev-server", tool: "read-file" },
    b = { name: "mcp__dev_server__read_file", server: "dev-server", tool: "read_file" };
  store.observeMcpTools("fixture", [a, b], { [old]: JSON.stringify([a.server, a.tool, false]) });
  assert.deepEqual(store.get("fixture"), ["read", next]);
  assert.deepEqual(store.getExecution("fixture"), ["ordinary", next]);
  assert.deepEqual(store.getMcpDeclaration("fixture"), ["read_mcp_resource", next]);
  assert.equal(store.mcpIdentityMatches("fixture", next), true);
  assert.equal(
    store.mcpIdentityMatches("fixture", b.name),
    false,
    "unproven grants require approval even if the name still exists",
  );
  const reopened = new DesktopSessionToolStore(file);
  reopened.observeMcpTools("fixture", [a, b]);
  assert.equal(reopened.mcpIdentityMatches("fixture", next), true);
  assert.equal(reopened.mcpIdentityMatches("fixture", b.name), false);
});

test("MCP grants bind raw identity across catalog replacement, fork and reapproval; declarations never validate a grant", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-grant-owners-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    store = new DesktopSessionToolStore(file);
  const a = { name: "mcp__fixture__a_b", server: "fixture", tool: "a.b" };
  store.set("fixture", ["read"]);
  store.setMcpExecution("fixture", [a.name]);
  store.observeMcpTools("fixture", [a]);
  assert.equal(store.mcpIdentityMatches("fixture", a.name), false);
  store.setMcpDeclaration("fixture", [a.name]);
  assert.equal(store.mcpIdentityMatches("fixture", a.name), false);
  store.setMcpExecution("fixture", [a.name]);
  assert.equal(store.mcpIdentityMatches("fixture", a.name), true);
  const b = { ...a, tool: "a_b" },
    newA = { ...a, name: "mcp__fixture__a_b_12345678" };
  store.observeMcpTools("fixture", [b, newA]);
  assert.equal(store.mcpIdentityMatches("fixture", b.name), false);
  assert.deepEqual(store.getMcpExecution("fixture"), [newA.name]);
  assert.equal(store.mcpIdentityMatches("fixture", newA.name), true);
  store.set("fork", ["read"]);
  store.setMcpExecution("fork", [newA.name]);
  store.copyMcpIdentities("fixture", "fork");
  store.observeMcpTools("fork", [newA]);
  assert.equal(store.mcpIdentityMatches("fork", newA.name), true);
  store.setMcpExecution("fixture", [b.name]);
  assert.equal(store.mcpIdentityMatches("fixture", b.name), true);
  assert.deepEqual(store.getMcpExecution("fixture"), [b.name]);
  store.forgetMcpCatalog("fixture");
  assert.equal(store.mcpIdentityMatches("fixture", b.name), false);
});

test("a proven declaration cannot validate an unrelated legacy execution alias at its new canonical name", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-declaration-provenance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session-tools.json"),
    old = "mcp__dev-server__a-b",
    canonical = "mcp__dev_server__a_b";
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        fixture: { toolNames: ["read", old], mcpExecutionToolNames: [canonical], mcpDeclarationToolNames: [old] },
      },
    }),
  );
  const store = new DesktopSessionToolStore(file),
    tool = { name: canonical, server: "dev-server", tool: "a-b" };
  store.observeMcpTools("fixture", [tool], { [old]: JSON.stringify([tool.server, tool.tool, false]) });
  assert.deepEqual(store.getMcpExecution("fixture"), []);
  assert.equal(store.mcpIdentityMatches("fixture", canonical), false);
  assert.deepEqual(store.getMcpDeclaration("fixture"), [canonical]);
});
