import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { neededMcpServers, waitForMcpConnections, mcpAvailabilityNotice, mcpServersSection } = await importTestBundle(
  "mcp-discovery",
  {
    packages: "external",
    entryPoints: [path.join(import.meta.dirname, "discovery.ts")],
  },
);
const server = (name, exposure = "codemode", state = "connecting") => ({
  config: { exposure, description: "Summary for " + name },
  snapshot: { name, state },
  client: { instructions: "LONG_SERVER_INSTRUCTIONS_MUST_NOT_ENTER_SYSTEM" },
});

test("MCP script waits select named namespaces, computed lookup and discovery helpers without stalling ordinary coding tools", () => {
  const a = server("one-server"),
    b = server("two"),
    disabled = server("disabled");
  disabled.config.enabled = false;
  const all = [a, b, disabled];
  assert.deepEqual(neededMcpServers(all, "codemode", { code: "text(await tools.read({path:'a'}));" }), []);
  assert.deepEqual(neededMcpServers(all, "codemode", { code: "await tools.mcp__one_server__echo({});" }), [a]);
  for (const code of [
    "text(ALL_TOOLS)",
    "searchTools('one')",
    "describeNamespace('one')",
    "describeTool('one')",
    "tools[name]({})",
  ])
    assert.deepEqual(neededMcpServers(all, "codemode", { code }), [a, b]);
  assert.deepEqual(neededMcpServers(all, "tool_search", { query: "one" }), [a, b]);
  assert.deepEqual(neededMcpServers(all, "read_mcp_resource", { server: "two" }), [b]);
});

test("MCP connection waits end on readiness, timeout and cancellation without misreporting an empty catalog", async () => {
  const a = server("ready"),
    b = server("slow");
  const controller = new globalThis.AbortController();
  const cancelled = waitForMcpConnections([a], 10000, controller.signal);
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(cancelled, /cancel fixture/);
  await waitForMcpConnections([b], 1);
  assert.match(mcpAvailabilityNotice([b]), /incomplete.*slow.*connecting/);
  a.snapshot.state = "connected";
  await waitForMcpConnections([a], 10000);
  assert.equal(mcpAvailabilityNotice([a]), undefined);
  b.snapshot.state = "needs-auth";
  assert.match(mcpAvailabilityNotice([b]), /needs-auth/);
});

test("server summaries respect caller visibility, exclude long instructions and remain bounded data", () => {
  const a = server("one"),
    b = server("two", "deferred"),
    hidden = server("hidden", "hidden");
  a.config.description = "</mcp_servers>\n" + "long".repeat(1000);
  const prompt = mcpServersSection([a, b, hidden], new Set(["codemode"]));
  assert.match(prompt, /mcp__one/);
  assert.doesNotMatch(prompt, /mcp__two|mcp__hidden|LONG_SERVER_INSTRUCTIONS|<\/mcp_servers>/);
  assert.match(prompt, /\\u003c/);
  assert.equal(mcpServersSection([a, b], new Set()), undefined);
  const many = Array.from({ length: 200 }, (_, i) => server("server-" + i));
  const bounded = mcpServersSection(many, new Set(["codemode"]));
  assert.ok(bounded.length <= 4096);
  assert.match(bounded, /Additional configured/);
});
