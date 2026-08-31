import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const readNdjson = (name) =>
  readFileSync(path.join(fixtureRoot, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("protocol fixtures cover every reviewed semantic method and event family", () => {
  const operations = readNdjson("operations-v20.ndjson");
  const methods = new Set(operations.flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : [])));
  assert.deepEqual(
    methods,
    new Set([
      "ping",
      "session.snapshot",
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
      "events.subscribe",
    ]),
  );
  const eventTypes = new Set(readNdjson("events-v20.ndjson").map((entry) => entry.event.type));
  for (const type of ["pane.updated", "pane.agent_detected", "tab.renamed", "workspace.updated", "layout.updated"]) {
    assert.equal(eventTypes.has(type), true, type);
  }
});

test("terminal fixtures include full/delta output, control commands, closure, and an explicit graphics rejection", () => {
  const output = readNdjson("terminal-v20.ndjson");
  assert.equal(
    output.some((entry) => entry.type === "terminal.frame" && entry.full === true),
    true,
  );
  assert.equal(
    output.some((entry) => entry.type === "terminal.frame" && entry.full === false),
    true,
  );
  assert.equal(
    output.some((entry) => entry.type === "terminal.closed"),
    true,
  );
  assert.deepEqual(
    readNdjson("terminal-commands-v20.ndjson").map((entry) => entry.type),
    ["terminal.input", "terminal.resize", "terminal.release"],
  );
  assert.equal(readNdjson("terminal-invalid-graphics-v20.ndjson")[0].encoding, "sixel");
});
