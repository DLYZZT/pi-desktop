import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { HERDR_V20_EVENT_SUBSCRIPTIONS, HERDR_V20_METHODS, numberField, optionalStringField, stringField } =
  await importTestBundle("src/agent-host/herdr/protocol-v20", {
    packages: "external",
    absWorkingDir: path.resolve(import.meta.dirname, "..", "..", ".."),
    entryPoints: ["src/agent-host/herdr/protocol-v20.ts"],
  });

test("protocol 20 pins the reviewed semantic allowlist and official schema fingerprint", () => {
  assert.deepEqual(Object.values(HERDR_V20_METHODS), [
    "ping",
    "session.snapshot",
    "events.subscribe",
    "workspace.create",
    "tab.create",
    "tab.focus",
    "tab.rename",
    "pane.split",
    "pane.read",
    "agent.start",
    "agent.prompt",
    "agent.send_keys",
    "agent.wait",
  ]);
  assert.equal(Object.values(HERDR_V20_METHODS).includes("pane.input.set"), false);
  assert.equal(
    Object.values(HERDR_V20_METHODS).some((method) => method.includes("raw")),
    false,
  );
  assert.equal(HERDR_V20_EVENT_SUBSCRIPTIONS.includes("pane.agent_detected"), true);
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  assert.equal(catalog.version, "0.8.2");
  assert.equal(catalog.protocol, 20);
  assert.equal(catalog.apiSchemaVersion, 1);
  assert.equal(catalog.apiSchemaSha256, "c48f1f54ee0150ca27e11fd44455fe94aeadb20fdf4e4a62393ed822a4e5b150");
});

test("wire field readers fail closed with schema errors for controls, bounds, and numeric drift", () => {
  assert.equal(stringField({ id: "pane-a" }, "id", 20), "pane-a");
  assert.equal(optionalStringField({ title: null }, "title"), undefined);
  assert.equal(numberField({ revision: 3 }, "revision"), 3);
  for (const invalid of ["", "line\nbreak", "line\rbreak", "nul\0byte", "x".repeat(21)]) {
    assert.throws(
      () => stringField({ id: invalid }, "id", 20),
      (error) => error.code === "HERDR_SCHEMA_INVALID",
    );
  }
  assert.throws(
    () => optionalStringField({ title: "line\nbreak" }, "title"),
    (error) => error.code === "HERDR_SCHEMA_INVALID",
  );
  assert.throws(
    () => numberField({ revision: 1.5 }, "revision"),
    (error) => error.code === "HERDR_SCHEMA_INVALID",
  );
});
