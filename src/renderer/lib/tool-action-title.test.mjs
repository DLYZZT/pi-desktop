import assert from "node:assert/strict";
import test from "node:test";
import { toolActionInput, toolActionTitle } from "./tool-action-title.ts";
import { phaseLabel } from "./agent-phase-label.ts";

const t = (_key, fallback) => fallback;

test("shell actions prefer a short description and fall back for missing or malformed descriptions", () => {
  for (const name of ["bash", "powershell"]) {
    assert.equal(
      toolActionTitle(name, { description: "Compare\n  two pages", command: "diff a b" }, t),
      "Compare two pages",
    );
    for (const description of [undefined, null, "  ", {}, 42]) {
      assert.equal(toolActionTitle(name, { description, command: "git status" }, t), "Run command: git status");
    }
  }
});

test("known tools use input templates without treating document content as intent", () => {
  for (const [name, input, expected] of [
    ["read", { path: "src/a.ts", description: "Untrusted content" }, "Read file: src/a.ts"],
    ["edit", { file_path: "src/a.ts", newText: "secret" }, "Edit file: src/a.ts"],
    ["write", { path: "new.ts", content: "secret" }, "Write file: new.ts"],
    ["ls", { path: "src" }, "List directory: src"],
    ["find", { pattern: "*.html" }, "Find files: *.html"],
    ["grep", { pattern: "LiveServer", path: "src" }, "Search file contents: LiveServer"],
    ["web_search", { query: "Pi tools" }, "Search the web: Pi tools"],
    ["web_fetch", { url: "https://example.com/docs" }, "Read web page: https://example.com/docs"],
    ["browser_navigate", { url: "https://example.com" }, "Open web page: https://example.com"],
    ["browser_inspect", {}, "Inspect web page"],
    ["codemode", { code: "private script" }, "Run a batch of operations"],
    ["mcp_custom", { description: "not a display field", content: "secret" }, "Call tool: mcp_custom"],
  ]) {
    assert.equal(toolActionTitle(name, input, t), expected);
  }
  assert.equal(toolActionTitle("read", undefined, t), "Read file");
  assert.equal(toolActionTitle("read", { path: {} }, t), "Read file");
});

test("long titles stay bounded without mutating original arguments", () => {
  const input = { description: "x".repeat(200), command: "git status" };
  const original = structuredClone(input);
  assert.equal(toolActionTitle("bash", input, t), `${"x".repeat(159)}…`);
  assert.deepEqual(input, original);
});

test("live action inputs retain only small display fields", () => {
  const input = {
    path: "a.ts",
    content: "secret",
    description: "ignored",
    command: "script",
    pattern: "x".repeat(200),
  };
  const display = toolActionInput("write", input);
  assert.deepEqual(Object.keys(display), ["path", "pattern"]);
  assert.equal(display.pattern.length, 160);
  assert.equal(toolActionInput("bash", input).description, "ignored");
  assert.equal(toolActionInput("bash", input).command, "script");
  for (const value of [undefined, null, [], "string", { content: "secret" }]) {
    assert.equal(toolActionInput("write", value), undefined);
  }
});

test("phase labels reuse action titles and count parallel calls without choosing an arbitrary intent", () => {
  assert.equal(
    phaseLabel(
      { kind: "running_tools", tools: [{ id: "1", name: "bash", input: { description: "Check repository state" } }] },
      t,
    ),
    "Check repository state",
  );
  assert.equal(
    phaseLabel({ kind: "running_tools", tools: [{ id: "1", name: "read", input: { path: "a.ts" } }] }, t),
    "Read file: a.ts",
  );
  assert.equal(
    phaseLabel(
      {
        kind: "running_tools",
        tools: [
          { id: "1", name: "read" },
          { id: "2", name: "bash" },
        ],
      },
      t,
    ),
    "Running 2 operations…",
  );
  assert.equal(phaseLabel({ kind: "waiting_model" }, t), "Waiting for model…");
});
