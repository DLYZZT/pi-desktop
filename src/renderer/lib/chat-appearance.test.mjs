import assert from "node:assert/strict";
import test from "node:test";
import { ChatAppearanceController, applyChatAppearance, scaledChatFont } from "./chat-appearance.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("DOM application writes only normalized, controlled data attributes", () => {
  const target = { dataset: {} };
  applyChatAppearance(target, { fontSize: "extra-large", layout: "wide" });
  assert.deepEqual(target.dataset, { chatFontSize: "extra-large", chatLayout: "wide" });
  assert.equal(scaledChatFont(13.5), "calc(13.5px * var(--chat-font-scale, 1))");
});

test("controller loads defaults after a read failure without blocking startup", async () => {
  const applied = [];
  const controller = new ChatAppearanceController({
    read: async () => {
      throw new Error("unavailable");
    },
    write: async () => undefined,
    apply: (value) => applied.push(value),
  });

  await controller.load();
  assert.deepEqual(controller.getSnapshot(), {
    preferences: { fontSize: "standard", layout: "fixed" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied, [{ fontSize: "standard", layout: "fixed" }]);
});

test("controller applies immediately and rolls back a failed save", async () => {
  const applied = [];
  const controller = new ChatAppearanceController({
    read: async () => ({ fontSize: "large", layout: "fixed" }),
    write: async () => {
      throw new Error("disk full");
    },
    apply: (value) => applied.push(value),
  });
  await controller.load();

  await assert.rejects(controller.update({ fontSize: "extra-large", layout: "wide" }), /disk full/);
  assert.deepEqual(controller.getSnapshot(), {
    preferences: { fontSize: "large", layout: "fixed" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied, [
    { fontSize: "large", layout: "fixed" },
    { fontSize: "extra-large", layout: "wide" },
    { fontSize: "large", layout: "fixed" },
  ]);
});

test("serialized updates never let a late failure roll back a newer value", async () => {
  const first = deferred();
  const second = deferred();
  const writes = [first, second];
  const applied = [];
  const controller = new ChatAppearanceController({
    read: async () => ({ fontSize: "standard", layout: "fixed" }),
    write: () => writes.shift().promise,
    apply: (value) => applied.push(value),
  });
  await controller.load();

  const updateOne = controller.update({ fontSize: "large", layout: "fixed" });
  const updateTwo = controller.update({ fontSize: "extra-large", layout: "wide" });
  first.reject(new Error("first failed"));
  await assert.rejects(updateOne, /first failed/);
  second.resolve();
  await updateTwo;

  assert.deepEqual(controller.getSnapshot(), {
    preferences: { fontSize: "extra-large", layout: "wide" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied.at(-1), { fontSize: "extra-large", layout: "wide" });
});
