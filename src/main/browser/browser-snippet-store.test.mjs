import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSnippetStore, assertSnippetSafe } from "./browser-snippet-store.ts";

test("snippet store saves explicitly approved code, deduplicates, scopes by host, and persists privately", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-snippets-"));
  const file = path.join(directory, "snippets.json");
  try {
    const store = new BrowserSnippetStore(file, () => 2);
    const first = store.save({
      pageUrl: "https://example.com/account",
      label: "Read account heading",
      code: "(() => document.querySelector('h1')?.textContent)()",
      resultPreview: "Account",
    });
    const duplicate = store.save({
      pageUrl: "https://example.com/settings",
      label: "Read current heading",
      code: "\n(() => document.querySelector('h1')?.textContent)()\r\n",
    });
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.enabled, true);
    assert.equal(duplicate.useCount, 2);
    assert.equal(store.listForUrl("https://example.com/settings").siteCount, 1);
    assert.equal(store.listForUrl("https://other.example/settings").siteCount, 0);
    assert.equal(store.getForUrl("https://example.com/settings", first.id).code.includes("querySelector"), true);
    assert.doesNotMatch(readFileSync(file, "utf8"), /Account.*Bearer/i);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    const restored = new BrowserSnippetStore(file, () => 2);
    assert.equal(restored.listAll().length, 1);
    restored.setEnabled(first.id, false);
    assert.equal(restored.listForUrl("https://example.com/settings").siteCount, 0);
    assert.throws(() => restored.getForUrl("https://example.com/settings", first.id));
    restored.setEnabled(first.id, true);
    assert.equal(restored.listForUrl("https://example.com/settings").siteCount, 1);
    restored.delete(first.id);
    assert.equal(restored.listAll().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snippet scanner rejects credential APIs and secret-like literals without echoing source", () => {
  assert.throws(
    () => assertSnippetSafe("document.cookie"),
    (error) => error.code === "PERMISSION_DENIED" && !error.message.includes("document.cookie"),
  );
  assert.throws(
    () => assertSnippetSafe(`const token = "${"a".repeat(100)}"`),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.throws(
    () => assertSnippetSafe("const report = '/Users/alice/private/report.csv'"),
    (error) => error.code === "PERMISSION_DENIED" && !error.message.includes("alice"),
  );
});

test("snippet store enforces per-host LRU capacity", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-snippet-lru-"));
  try {
    const store = new BrowserSnippetStore(path.join(directory, "snippets.json"), () => 5);
    store.save({ pageUrl: "https://example.com/a", label: "a", code: "1 + 1" });
    store.save({ pageUrl: "https://example.com/b", label: "b", code: "2 + 2" });
    store.save({ pageUrl: "https://example.com/c", label: "c", code: "3 + 3" });
    store.save({ pageUrl: "https://example.com/d", label: "d", code: "4 + 4" });
    store.save({ pageUrl: "https://example.com/e", label: "e", code: "5 + 5" });
    store.save({ pageUrl: "https://example.com/f", label: "f", code: "6 + 6" });
    assert.equal(store.listAll().length, 5);
    assert.deepEqual(
      store
        .listAll()
        .map((snippet) => snippet.label)
        .sort(),
      ["b", "c", "d", "e", "f"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snippet store recovers corruption and migrates entries created before enabled state existed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-browser-snippet-migration-"));
  const file = path.join(directory, "snippets.json");
  try {
    writeFileSync(file, "{not-json", "utf8");
    assert.deepEqual(new BrowserSnippetStore(file, () => 40).listAll(), []);

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        snippets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            host: "example.com",
            pathPattern: "/",
            label: "Legacy safe snippet",
            code: "document.title",
            codeHash: "legacy-hash",
            useCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const migrated = new BrowserSnippetStore(file, () => 40);
    assert.equal(migrated.listAll()[0].enabled, true);
    assert.equal(migrated.listForUrl("https://example.com/").siteCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
