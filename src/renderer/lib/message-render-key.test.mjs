import assert from "node:assert/strict";
import test from "node:test";

import { MessageRenderKeyRegistry } from "./message-render-key.ts";

test("entry-backed message keys survive history prepend and distinguish render roles", () => {
  const registry = new MessageRenderKeyRegistry();
  const message = {};

  assert.equal(registry.keyFor(message, "entry-7", "message"), "entry:entry-7:message");
  assert.equal(registry.keyFor({}, "entry-7", "process"), "entry:entry-7:process");
  assert.equal(registry.keyFor({}, "entry-7", "final"), "entry:entry-7:final");
});

test("messages without entry ids retain object-local keys without using array indices", () => {
  const registry = new MessageRenderKeyRegistry();
  const first = {};
  const second = {};
  const firstKey = registry.keyFor(first, undefined, "message");

  assert.equal(registry.keyFor(first, undefined, "message"), firstKey);
  assert.notEqual(registry.keyFor(second, undefined, "message"), firstKey);
  assert.equal(registry.keyFor(first, undefined, "process"), firstKey.replace(/:message$/, ":process"));
});
