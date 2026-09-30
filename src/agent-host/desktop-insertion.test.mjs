import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { AgentSessionWrapper } = await importTestBundle("desktop-insertion", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "rpc-manager.ts")],
});
function fixture(t) {
  const wrapper = new AgentSessionWrapper({ agent: {}, sessionId: "fixture" }, undefined, () => {});
  t.after(() => wrapper.destroy());
  const ui = wrapper.createExtensionUiContext();
  return { wrapper, ui };
}
test("insertion is not replayable and close cancels its acknowledgement", async (t) => {
  const { wrapper, ui } = fixture(t);
  assert.equal(await ui.insertEditorTextIfEmpty("x"), "unavailable");
  const panel = wrapper.customUiBridge.open(() => ({ render: () => ["body"] }));
  const insertion = ui.insertEditorTextIfEmpty("x");
  assert.equal(wrapper.pendingUiResponses.size, 1);
  assert.equal(
    [...wrapper.pendingUiRequests.values()].some((e) => e.method === "insert_editor_text_if_empty"),
    false,
  );
  wrapper.customUiBridge.closeAll();
  await panel;
  assert.equal(await insertion, "unavailable");
  assert.equal(wrapper.pendingUiResponses.size, 0);
});
test("unanswered insertion expires and late replies cannot revive it", async (t) => {
  const { wrapper, ui } = fixture(t);
  const panel = wrapper.customUiBridge.open(() => ({ render: () => ["body"] }));
  const insertion = ui.insertEditorTextIfEmpty("x");
  const [id] = wrapper.pendingUiResponses.keys();
  assert.equal(await insertion, "unavailable");
  assert.equal(wrapper.pendingUiResponses.has(id), false);
  await wrapper.send({ type: "extension_ui_response", id, confirmed: true });
  assert.equal(ui.getEditorText(), "");
  wrapper.customUiBridge.closeAll();
  await panel;
});
