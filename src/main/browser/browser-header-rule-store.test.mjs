import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserHeaderRuleStore } from "./browser-header-rule-store.ts";

function rule(id, metadata = {}) {
  return {
    id,
    enabled: true,
    profileId: "profile",
    urlPattern: "https://example.test/*",
    header: "x-test",
    operation: "set",
    value: id,
    ...metadata,
  };
}

test("migrates legacy rules as local and persists only local ownership", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-header-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json");
  writeFileSync(filePath, JSON.stringify({ version: 1, request: { profile: [rule("legacy")] }, response: {} }), "utf8");

  const store = new BrowserHeaderRuleStore(filePath);
  assert.deepEqual(
    store.get("profile", "request").map(({ id, source }) => ({ id, source })),
    [{ id: "legacy", source: "local" }],
  );
  store.set("profile", "request", [rule("updated", { source: "agent", ownerSessionId: "session" })]);

  const persisted = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(persisted.version, 2);
  assert.deepEqual(
    persisted.request.profile.map(({ id, source }) => ({ id, source })),
    [{ id: "updated", source: "local" }],
  );
  assert.equal(Object.hasOwn(persisted.request.profile[0], "ownerSessionId"), false);
});

test("drops Agent-owned records if they are injected into the persistent v2 file", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-header-store-agent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 2,
      request: { profile: [rule("local", { source: "local" }), rule("agent", { source: "agent" })] },
      response: {},
    }),
    "utf8",
  );

  const store = new BrowserHeaderRuleStore(filePath);
  assert.deepEqual(
    store.get("profile", "request").map(({ id }) => id),
    ["local"],
  );
});
