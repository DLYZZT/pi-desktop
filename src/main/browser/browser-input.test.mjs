import assert from "node:assert/strict";
import test from "node:test";
import { pressBrowserKey, scrollBrowserPage, sendBrowserMouseClick, typeBrowserText } from "./browser-input.ts";

function harness() {
  const calls = [];
  const state = { inputs: 0, debuggerUsers: 0 };
  const target = {
    tabId: "tab",
    humanized: () => false,
    async withSyntheticInput(task) {
      state.inputs++;
      try {
        return await task();
      } finally {
        state.inputs--;
      }
    },
    cdp: {
      acquire() {
        state.debuggerUsers++;
        return () => {
          state.debuggerUsers--;
        };
      },
      async sendCommand(_id, method, params) {
        calls.push({ method, params });
      },
    },
    contents: {
      focus() {
        calls.push({ method: "focus" });
      },
      sendInputEvent(event) {
        assert.equal(state.inputs, 1);
        calls.push({ method: "input", params: event });
      },
      async executeJavaScriptInIsolatedWorld() {
        return { width: 100, height: 80 };
      },
    },
  };
  return { target, calls, state };
}

test("typing keeps focus through frame selection and sends ASCII, Unicode and submit through the input scope", async () => {
  const h = harness();
  let frameReads = 0;
  const frame = {
    async executeJavaScript() {
      frameReads++;
      return { x: 4, y: 5 };
    },
  };
  const mode = await typeBrowserText(
    h.target,
    { frame, offsetX: 10, offsetY: 20 },
    "snapshot",
    "e0",
    "A字",
    true,
    new globalThis.AbortController().signal,
  );
  assert.equal(mode, "mixed-insert-text");
  assert.equal(frameReads, 3);
  const click = h.calls.find(
    ({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  );
  assert.deepEqual([click.params.x, click.params.y], [14, 25]);
  const ascii = h.calls.filter(({ method, params }) => method === "input" && params.keyCode === "A");
  assert.deepEqual(
    ascii.map(({ params }) => params.type),
    ["keyDown", "char", "keyUp"],
  );
  assert.ok(h.calls.some(({ method, params }) => method === "Input.dispatchKeyEvent" && params.text === "字"));
  const submit = h.calls.filter(({ method, params }) => method === "input" && params.keyCode === "Enter");
  assert.deepEqual(
    submit.map(({ params }) => params.type),
    ["keyDown", "char", "keyUp"],
  );
  const focusOff = h.calls.findIndex(
    ({ method, params }) => method === "Emulation.setFocusEmulationEnabled" && params.enabled === false,
  );
  assert.equal(focusOff, h.calls.length - 1);
  assert.deepEqual(h.state, { inputs: 0, debuggerUsers: 0 });
});

test("key shortcuts omit character events and always release the input scope after a native failure", async () => {
  const h = harness();
  await pressBrowserKey(h.target, "a", ["control"]);
  assert.deepEqual(
    h.calls.filter(({ method }) => method === "input").map(({ params }) => params.type),
    ["keyDown", "keyUp"],
  );
  h.target.contents.sendInputEvent = () => {
    throw new Error("Renderer closed");
  };
  await assert.rejects(pressBrowserKey(h.target, "a", []), /Renderer closed/);
  assert.equal(h.state.inputs, 0);
});

test("mouse dispatch failure restores focus emulation and releases the CDP lease", async () => {
  const h = harness();
  const send = h.target.cdp.sendCommand;
  h.target.cdp.sendCommand = async (id, method, params) => {
    await send(id, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") throw new Error("Renderer failed");
  };
  await assert.rejects(
    sendBrowserMouseClick(h.target, 10, 20, "right", 2, new globalThis.AbortController().signal, ["alt", "shift"]),
    /Renderer failed/,
  );
  const down = h.calls.find(({ params }) => params?.type === "mousePressed").params;
  assert.equal(down.buttons, 2);
  assert.equal(down.modifiers, 9);
  assert.equal(down.clickCount, 2);
  assert.deepEqual(h.calls.at(-1), { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } });
  assert.equal(h.state.debuggerUsers, 0);
});

test("scroll clamps to the viewport and releases both input and debugger resources after cancellation", async () => {
  const h = harness();
  const controller = new globalThis.AbortController();
  const send = h.target.contents.sendInputEvent;
  h.target.contents.sendInputEvent = (event) => {
    send(event);
    controller.abort();
  };
  await assert.rejects(
    scrollBrowserPage(h.target, { x: 200, y: -10 }, 12, 45, controller.signal),
    (error) => error.code === "USER_TOOK_CONTROL",
  );
  const wheel = h.calls.find(({ method }) => method === "input").params;
  assert.deepEqual([wheel.x, wheel.y, wheel.deltaX, wheel.deltaY], [99, 0, 12, 45]);
  assert.deepEqual(h.state, { inputs: 0, debuggerUsers: 0 });
  assert.deepEqual(h.calls.at(-1), { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } });
});
