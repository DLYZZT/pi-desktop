import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPermissionGrantStore } from "./browser-permission-grants.ts";

test("permission checks peek without consuming an allow-once grant", () => {
  const grants = new BrowserPermissionGrantStore();
  grants.allowOnce("origin\0fullscreen");

  assert.equal(grants.peek("origin\0fullscreen"), true);
  assert.equal(grants.peek("origin\0fullscreen"), true);
  assert.equal(grants.consume("origin\0fullscreen"), true);
  assert.equal(grants.peek("origin\0fullscreen"), false);
  assert.equal(grants.consume("origin\0fullscreen"), false);
});

test("session grants survive consumption and clear removes every grant", () => {
  const grants = new BrowserPermissionGrantStore();
  grants.allowOnce("once");
  grants.allowSession("session");

  assert.equal(grants.consume("session"), true);
  assert.equal(grants.consume("session"), true);
  grants.clear();
  assert.equal(grants.peek("once"), false);
  assert.equal(grants.peek("session"), false);
});
