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
  applyChatAppearance(target, { fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" });
  assert.deepEqual(target.dataset, {
    chatFontSize: "extra-large",
    chatLayout: "wide",
    chatAssistantWidth: "comfortable",
  });
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
    preferences: { fontSize: "standard", layout: "fixed", assistantWidth: "comfortable" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied, [{ fontSize: "standard", layout: "fixed", assistantWidth: "comfortable" }]);
});

test("controller applies immediately and rolls back a failed save", async () => {
  const applied = [];
  const controller = new ChatAppearanceController({
    read: async () => ({ fontSize: "large", layout: "fixed", assistantWidth: "comfortable" }),
    write: async () => {
      throw new Error("disk full");
    },
    apply: (value) => applied.push(value),
  });
  await controller.load();

  await assert.rejects(
    controller.update({ fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" }),
    /disk full/,
  );
  assert.deepEqual(controller.getSnapshot(), {
    preferences: { fontSize: "large", layout: "fixed", assistantWidth: "comfortable" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied, [
    { fontSize: "large", layout: "fixed", assistantWidth: "comfortable" },
    { fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" },
    { fontSize: "large", layout: "fixed", assistantWidth: "comfortable" },
  ]);
});

test("serialized updates never let a late failure roll back a newer value", async () => {
  const first = deferred();
  const second = deferred();
  const writes = [first, second];
  const applied = [];
  const controller = new ChatAppearanceController({
    read: async () => ({ fontSize: "standard", layout: "fixed", assistantWidth: "comfortable" }),
    write: () => writes.shift().promise,
    apply: (value) => applied.push(value),
  });
  await controller.load();

  const updateOne = controller.update({ fontSize: "large", layout: "fixed", assistantWidth: "comfortable" });
  const updateTwo = controller.update({ fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" });
  first.reject(new Error("first failed"));
  await assert.rejects(updateOne, /first failed/);
  second.resolve();
  await updateTwo;

  assert.deepEqual(controller.getSnapshot(), {
    preferences: { fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" },
    loaded: true,
    saving: false,
  });
  assert.deepEqual(applied.at(-1), { fontSize: "extra-large", layout: "wide", assistantWidth: "comfortable" });
});

test("reply width persists independently of layout, reloads, and rolls back a failed save", async () => {
  let stored = { fontSize: "standard", layout: "wide" };
  let failSave = false;
  const target = { dataset: {} };
  const dependencies = {
    read: async () => stored,
    write: async (preferences) => {
      if (failSave) throw new Error("disk full");
      stored = JSON.parse(JSON.stringify(preferences));
    },
    apply: (preferences) => applyChatAppearance(target, preferences),
  };
  const controller = new ChatAppearanceController(dependencies);
  await controller.load();
  await controller.update({ ...controller.getSnapshot().preferences, assistantWidth: "full" });
  assert.deepEqual(stored, { fontSize: "standard", layout: "wide", assistantWidth: "full" });

  const reloaded = new ChatAppearanceController(dependencies);
  await reloaded.load();
  assert.deepEqual(reloaded.getSnapshot().preferences, stored);
  assert.deepEqual(target.dataset, { chatFontSize: "standard", chatLayout: "wide", chatAssistantWidth: "full" });

  await reloaded.update({ ...reloaded.getSnapshot().preferences, layout: "fixed" });
  assert.equal(stored.assistantWidth, "full");
  failSave = true;
  await assert.rejects(reloaded.update({ ...stored, assistantWidth: "comfortable" }), /disk full/);
  assert.equal(reloaded.getSnapshot().preferences.assistantWidth, "full");
  assert.equal(target.dataset.chatAssistantWidth, "full");
});
