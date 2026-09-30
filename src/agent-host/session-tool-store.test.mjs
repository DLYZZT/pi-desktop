import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { DesktopSessionToolStore } = await importTestBundle("src/agent-host/session-tool-store", {
  packages: "external",
  stdin: {
    contents: 'export { DesktopSessionToolStore } from "./session-tool-store.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "session-tool-store-test-entry.ts",
    loader: "ts",
  },
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
  const store = new DesktopSessionToolStore(filename);
  store.set("fixture", ["read"]);
  assert.equal(store.getExecution("fixture"), undefined);
  store.setExecution("fixture", [" deferred ", "deferred", "powershell"]);
  const granted = store.getExecution("fixture");
  assert.deepEqual(granted, ["deferred"]);
  granted.push("other");
  assert.deepEqual(store.getExecution("fixture"), ["deferred"]);
  store.set("fixture", ["read", "write"]);
  assert.deepEqual(new DesktopSessionToolStore(filename).getExecution("fixture"), ["deferred"]);
  store.set("fixture", []);
  assert.deepEqual(new DesktopSessionToolStore(filename).getExecution("fixture"), []);
  store.set("fixture", ["read"]);
  assert.equal(new DesktopSessionToolStore(filename).getExecution("fixture"), undefined);
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
