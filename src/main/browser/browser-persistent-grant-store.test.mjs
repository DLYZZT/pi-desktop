import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserPersistentGrantStore } from "./browser-persistent-grant-store.ts";

test("persistent Browser grants are private, atomic, reloadable, and support inherit deletion", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-grants-"));
  const file = path.join(directory, "browser-session-grants.json");
  try {
    const store = new BrowserPersistentGrantStore(file);
    store.set("session-a", "read");
    store.set("session-b", "advanced");
    assert.equal(store.get("session-a")?.permission, "read");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    const reloaded = new BrowserPersistentGrantStore(file);
    assert.deepEqual(
      reloaded.list().map(({ sessionId, permission }) => ({ sessionId, permission })),
      [
        { sessionId: "session-a", permission: "read" },
        { sessionId: "session-b", permission: "advanced" },
      ],
    );
    reloaded.set("session-a", "inherit");
    assert.equal(reloaded.get("session-a"), undefined);
    assert.equal(reloaded.get("session-b")?.permission, "advanced");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent Browser grant corruption recovers empty and GC removes deleted sessions", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-grants-"));
  const file = path.join(directory, "browser-session-grants.json");
  try {
    writeFileSync(file, "{broken", "utf8");
    const store = new BrowserPersistentGrantStore(file);
    assert.deepEqual(store.list(), []);
    store.set("keep", "ask");
    store.set("delete", "deny");
    store.gc(["keep"]);
    assert.equal(store.get("keep")?.permission, "ask");
    assert.equal(store.get("delete"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
