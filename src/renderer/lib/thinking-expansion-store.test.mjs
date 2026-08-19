import assert from "node:assert/strict";
import test from "node:test";

import { ThinkingExpansionRegistry, ThinkingExpansionStore } from "./thinking-expansion-store.ts";

test("thinking expansion uses stable ids and synchronizes subscribers without storing content", () => {
  const store = new ThinkingExpansionStore(2);
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  assert.equal(store.getSnapshot("entry-1:0"), false);
  assert.equal(store.getSnapshot("entry-untouched:0"), false);
  store.toggle("entry-1:0");
  assert.equal(store.getSnapshot("entry-1:0"), true);
  assert.equal(
    store.getSnapshot("entry-untouched:0"),
    false,
    "changing the default cannot overwrite a block that was already observed",
  );
  assert.equal(store.getSnapshot("entry-2:0"), true, "last choice is captured by newly observed blocks");
  store.toggle("entry-2:0");
  store.toggle("entry-3:0");
  assert.deepEqual(store.keysForTest(), ["entry-2:0", "entry-3:0"]);
  assert.equal(updates, 3);
  assert.equal(
    store.keysForTest().some((key) => key.includes("reasoning text")),
    false,
  );
  unsubscribe();
});

test("registry isolates sessions, bounds retained stores, and clears deleted sessions", () => {
  const registry = new ThinkingExpansionRegistry(2, 5);
  const first = registry.get("session-1");
  first.toggle("entry:0");
  const second = registry.get("session-2");
  assert.equal(second.getSnapshot("entry:0"), false);
  registry.get("session-3");
  assert.equal(registry.sizeForTest(), 2);
  assert.equal(first.sizeForTest(), 0, "eviction clears retained state");
  registry.delete("session-2");
  assert.equal(registry.sizeForTest(), 1);
});
