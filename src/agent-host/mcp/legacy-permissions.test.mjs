import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { readLegacyMcpEvidence, ExecutionLogStore, DesktopSessionToolStore } = await importTestBundle(
  "mcp-legacy-permissions",
  {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: `
  export {readLegacyMcpEvidence} from './legacy-permissions.ts';
  export {ExecutionLogStore} from '../execution-log-store.ts';
  export {DesktopSessionToolStore} from '../session-tool-store.ts';`,
    },
  },
);
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-legacy-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    store: new ExecutionLogStore("fixture", root),
    journal: path.join(root, "tool-executions/fixture.jsonl"),
  };
}
async function record(store, name, tool, sequence = 1, text = "x".repeat(6000)) {
  return store.append({
    executionId: "call-" + sequence,
    runId: "run",
    toolCallId: "call-" + sequence,
    parentToolCallId: "codemode-parent",
    rootToolCallId: "codemode-parent",
    source: "local",
    toolName: name,
    status: "succeeded",
    requestedAt: 1791200000000,
    startedAt: 1791200000001,
    endedAt: 1791200000002,
    result: await store.payload({
      content: [{ type: "text", text }],
      details: { mcp: { server: "dev-server", tool } },
    }),
  });
}
test("nested MCP identities can migrate from durable content references without editing either execution or native history", async (t) => {
  const f = fixture(t),
    old = "mcp__dev-server__read-file";
  await record(f.store, old, "read-file");
  const before = readFileSync(f.journal, "utf8"),
    native = [];
  const proof = await readLegacyMcpEvidence(native, [old], "2026-01-01T00:00:00Z", { store: f.store });
  assert.deepEqual(proof, { [old]: JSON.stringify(["dev-server", "read-file", false]) });
  assert.equal(readFileSync(f.journal, "utf8"), before);
  assert.deepEqual(native, []);
  const preferences = new DesktopSessionToolStore(path.join(f.root, "session-tools.json"));
  preferences.set("fixture", ["read"]);
  preferences.setMcpExecution("fixture", [old]);
  const current = { name: "mcp__dev_server__read_file", server: "dev-server", tool: "read-file" };
  preferences.observeMcpTools("fixture", [current], proof);
  assert.equal(preferences.mcpIdentityMatches("fixture", current.name), true);
  assert.deepEqual(preferences.getMcpExecution("fixture"), [current.name]);
});
test("competing nested raw identities never share a migrated permission", async (t) => {
  const f = fixture(t),
    old = "mcp__dev-server__a_b";
  await record(f.store, old, "a.b");
  await record(f.store, old, "a_b", 2);
  assert.deepEqual(await readLegacyMcpEvidence([], [old], undefined, { store: f.store }), {});
});
test("oversized or corrupt execution evidence stays untouched and requires fresh approval", async (t) => {
  const f = fixture(t),
    old = "mcp__dev-server__echo";
  await record(f.store, old, "echo", 1, "x".repeat(2097153));
  const native = [
    {
      type: "message",
      timestamp: "2026-10-06T00:00:00Z",
      message: { role: "toolResult", toolName: old, details: { mcp: { server: "dev-server", tool: "echo" } } },
    },
  ];
  assert.deepEqual(await readLegacyMcpEvidence(native, [old], undefined, { store: f.store }), {});
  appendFileSync(f.journal, "{broken tail");
  const before = readFileSync(f.journal, "utf8");
  assert.deepEqual(await readLegacyMcpEvidence(native, [old], undefined, { store: f.store }), {});
  assert.equal(readFileSync(f.journal, "utf8"), before);
});
