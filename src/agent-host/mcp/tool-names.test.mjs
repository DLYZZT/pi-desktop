import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { McpToolNames, legacyMcpIdentityEvidence } = await importTestBundle("mcp-tool-names", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "tool-names.ts")],
});
const identity = ({ server, tool, resource }) => JSON.stringify([server, tool, resource === true]);
const fixture = (tool, server = "dev-server", resource = false) => ({ server, tool, resource });
function resolve(tools) {
  const registry = new McpToolNames();
  registry.add(tools);
  return [...registry.resolve()].sort(([a], [b]) => a.localeCompare(b));
}

test("all sanitized collisions are hashed independent of catalog ordering; long and Unicode names stay callable", () => {
  const tools = [
    fixture("read-file"),
    fixture("read_file"),
    fixture("read.file"),
    fixture("读图"),
    fixture("long".repeat(90)),
  ];
  assert.deepEqual(resolve(tools), resolve([...tools].reverse()));
  const resolved = new Map(resolve(tools));
  const names = [...resolved.values()].map((item) => item.name);
  assert.equal(new Set(names).size, tools.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_]{1,64}$/);
  for (const tool of tools.slice(0, 3)) assert.match(resolved.get(identity(tool)).name, /_[a-f0-9]{8}$/);
  assert.equal(resolved.get(identity(fixture("read-file"))).server, "dev-server");
});

test("resource wrappers and raw read_resource tools never share an identifier or owner", () => {
  const tools = [fixture("read_resource"), fixture("__read_resource"), fixture("__read_resource", "dev-server", true)];
  const values = resolve(tools).map(([, value]) => value);
  assert.equal(new Set(values.map((value) => value.name)).size, 3);
  assert.equal(values.filter((value) => value.resource).length, 1);
});

test("delimiter ambiguities and names equal to another generated hash are resolved as groups", () => {
  const a = fixture("b__echo", "a"),
    b = fixture("echo", "a__b");
  const ab = resolve([a, b]);
  assert.ok(ab.every(([, value]) => /_[a-f0-9]{8}$/.test(value.name)));
  const original = fixture("x".repeat(100), "a");
  const hashName = resolve([original])[0][1].name;
  const literal = fixture(hashName.slice("mcp__a__".length), "a");
  const resolved = resolve([original, literal]);
  assert.equal(new Set(resolved.map(([, value]) => value.name)).size, 2);
  assert.deepEqual(resolved, resolve([literal, original]));
});

test("catalog additions invalidate the old plain alias and removals cannot donate it to a different owner", () => {
  const registry = new McpToolNames(),
    a = fixture("read-file"),
    b = fixture("read_file");
  registry.add([a]);
  const plain = registry.resolve().get(identity(a)).name;
  registry.add([b]);
  const both = registry.resolve();
  assert.notEqual(both.get(identity(a)).name, plain);
  assert.notEqual(both.get(identity(b)).name, plain);
  registry.add([b]);
  assert.deepEqual(registry.resolve(), both);
  const reserved = new Set([both.get(identity(b)).name]);
  assert.throws(() => registry.resolve(reserved), /hash collision/);
});

test("legacy migration uses unique raw result identities and never mutates transcript evidence", () => {
  const entry = (name, tool, timestamp = "2026-10-06T11:00:00Z") => ({
    type: "message",
    timestamp,
    message: { role: "toolResult", toolName: name, details: { mcp: { server: "dev-server", tool } } },
  });
  const entries = [
    entry("mcp__dev-server__read-file", "read-file"),
    entry("mcp__dev-server__a_b", "a.b"),
    entry("mcp__dev-server__a_b", "a_b"),
    entry("mcp__dev-server__stale", "stale", "2026-10-01T00:00:00Z"),
    entry("mcp__unrelated__alias", "echo"),
  ];
  const before = JSON.stringify(entries);
  const evidence = legacyMcpIdentityEvidence(entries, "2026-10-06T10:00:00Z");
  assert.deepEqual(evidence, { "mcp__dev-server__read-file": identity(fixture("read-file")) });
  assert.equal(JSON.stringify(entries), before);
});
