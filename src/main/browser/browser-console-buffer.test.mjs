import assert from "node:assert/strict";
import test from "node:test";

import { BrowserConsoleBuffer } from "./browser-console-buffer.ts";

class FakeCdp {
  listener;
  commands = [];

  subscribe(_tabId, listener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async enableDomain(tabId, domain) {
    this.commands.push(`${tabId}:${domain}.enable`);
    return async () => this.commands.push(`${tabId}:${domain}.disable`);
  }

  emit(method, params) {
    this.listener?.({ method, params });
  }
}

test("Console buffer captures bounded primitive data, redacts secrets, filters, waits, and cleans up", async () => {
  const cdp = new FakeCdp();
  const buffer = new BrowserConsoleBuffer("tab-1", cdp, 10, () => 1234);
  await buffer.start();
  cdp.emit("Runtime.consoleAPICalled", {
    type: "error",
    args: [{ type: "string", value: "token=secret https://example.com/a?code=private&view=1" }],
    stackTrace: {
      callFrames: [
        { functionName: "run", url: "https://example.com/app?token=secret", lineNumber: 4, columnNumber: 2 },
      ],
    },
  });
  const page = buffer.list({ levels: ["error"] });
  assert.equal(page.entries.length, 1);
  assert.doesNotMatch(page.entries[0].text, /secret|private/);
  assert.match(page.entries[0].text, /redacted/i);
  assert.doesNotMatch(page.entries[0].source, /secret/);

  const pending = buffer.wait({ after: page.entries[0].id, levels: ["warning"], timeoutMs: 1_000 });
  cdp.emit("Log.entryAdded", {
    entry: { level: "warning", text: "later warning", url: "https://example.com/warn", timestamp: 2_000 },
  });
  assert.equal((await pending).level, "warning");
  await buffer.stop();
  assert.equal(buffer.count(), 0);
  assert.deepEqual(cdp.commands, [
    "tab-1:Runtime.enable",
    "tab-1:Log.enable",
    "tab-1:Log.disable",
    "tab-1:Runtime.disable",
  ]);
});

test("Console cursor expires after bounded ring-buffer eviction", async () => {
  const cdp = new FakeCdp();
  const buffer = new BrowserConsoleBuffer("tab-1", cdp, 2);
  await buffer.start();
  for (const text of ["one", "two", "three"]) {
    cdp.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: text }] });
  }
  const page = buffer.list({});
  assert.equal(page.entries.length, 2);
  assert.throws(
    () => buffer.list({ after: "00000000-0000-4000-8000-000000000000" }),
    (error) => error.code === "CONSOLE_CURSOR_EXPIRED",
  );
  await buffer.stop();
});
