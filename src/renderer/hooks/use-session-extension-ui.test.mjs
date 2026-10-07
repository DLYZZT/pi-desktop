import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useSessionExtensionUi, SessionRuntimeGate, commands } = await importTestBundle("session-extension-ui", {
  stdin: {
    contents:
      'export {useSessionExtensionUi} from "./useSessionExtensionUi.ts"; export {SessionRuntimeGate} from "@/lib/session-runtime-gate"; export {commands} from "@/lib/agent-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "extension-commands",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/agent-client$/ }, ({ path }) => ({ path, namespace: "extension-test" }));
        build.onLoad({ filter: /.*/, namespace: "extension-test" }, () => ({
          loader: "js",
          contents: `
      export const commands = [];
      export async function sendAgentCommand(sid, command) { commands.push({sid, command}); return {}; }
    `,
        }));
      },
    },
  ],
});

async function mount(t) {
  commands.length = 0;
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("document", { title: "original" });
  let now = 1000,
    nextTimer = 0;
  const timers = new Map(),
    realNow = Date.now;
  Date.now = () => now;
  install("setTimeout", (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  install("clearTimeout", (id) => timers.delete(id));
  const controller = new globalThis.AbortController();
  const sessionIdRef = { current: "a" },
    inserted = [],
    runtimeGate = new SessionRuntimeGate();
  const options = {
    sessionIdRef,
    runtimeGate,
    getViewSignal: () => controller.signal,
    chatInputRef: { current: { insertText: (text) => inserted.push(text) } },
  };
  let current, renderer;
  function Probe() {
    current = useSessionExtensionUi(options);
    return null;
  }
  const unmount = async () => {
    controller.abort();
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    Date.now = realNow;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    sessionIdRef,
    runtimeGate,
    inserted,
    timers,
    unmount,
    emit: (request) => act(async () => current.handleExtensionUiRequest({ type: "extension_ui_request", ...request })),
    async advance(ms) {
      now += ms;
      await act(async () => {
        for (const [id, timer] of [...timers])
          if (timer.at <= now) {
            timers.delete(id);
            timer.callback();
          }
      });
    },
  };
}

test("replaced dialogs and duplicate clicks cannot send a stale response", async (t) => {
  const fixture = await mount(t);
  await fixture.emit({ id: "same", method: "confirm", title: "first", message: "first" });
  const first = fixture.current.extensionDialog;
  await fixture.emit({ id: "same", method: "confirm", title: "second", message: "second" });
  const second = fixture.current.extensionDialog;
  await act(async () => fixture.current.respondToExtensionUi(first, { confirmed: true }));
  assert.equal(fixture.current.extensionDialog, second);
  assert.equal(commands.length, 0);
  await act(async () =>
    Promise.all([
      fixture.current.respondToExtensionUi(second, { confirmed: true }),
      fixture.current.respondToExtensionUi(second, { confirmed: false }),
    ]),
  );
  assert.deepEqual(commands, [{ sid: "a", command: { type: "extension_ui_response", id: "same", confirmed: true } }]);
  assert.equal(fixture.current.extensionDialog, null);
});

test("responses stay with their originating session and cannot run after unmount", async (t) => {
  const fixture = await mount(t);
  await fixture.emit({ id: "dialog", method: "input", title: "input" });
  const request = fixture.current.extensionDialog;
  fixture.sessionIdRef.current = "b";
  await act(async () => fixture.current.respondToExtensionUi(request, { value: "late" }));
  assert.equal(commands.length, 0);
  fixture.sessionIdRef.current = "a";
  await fixture.unmount();
  await fixture.current.respondToExtensionUi(request, { value: "unmounted" });
  assert.equal(commands.length, 0);
  fixture.current.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "editor",
    method: "set_editor_text",
    text: "late",
  });
  assert.deepEqual(fixture.inserted, []);
});

test("expired dialogs disappear and cannot respond or reappear from a stale replay", async (t) => {
  const fixture = await mount(t);
  await fixture.emit({ id: "expires", method: "select", title: "pick", options: ["one"], expiresAt: 1200 });
  const request = fixture.current.extensionDialog;
  await fixture.advance(200);
  assert.equal(fixture.current.extensionDialog, null);
  await act(async () => fixture.current.respondToExtensionUi(request, { value: "one" }));
  await fixture.emit(request);
  assert.equal(fixture.current.extensionDialog, null);
  assert.equal(commands.length, 0);
});

test("custom repaint callbacks remain valid until the panel closes, including ID reuse", async (t) => {
  const fixture = await mount(t);
  await fixture.emit({ id: "custom", method: "custom", lines: ["frame one"] });
  const first = fixture.current.extensionCustomUi;
  await fixture.emit({ id: "custom", method: "custom", lines: ["frame two"] });
  await act(async () => fixture.current.sendExtensionCustomInput(first, "a"));
  assert.equal(commands.length, 1);
  await fixture.emit({ id: "unrelated", method: "custom", lines: [], closed: true });
  assert.deepEqual(fixture.current.extensionCustomUi.lines, ["frame two"]);
  await fixture.emit({ id: "custom", method: "custom", lines: [], closed: true });
  assert.equal(fixture.current.extensionCustomUi, null);
  await fixture.emit({ id: "custom", method: "custom", lines: ["reopened"] });
  await act(async () => fixture.current.sendExtensionCustomInput(first, "stale"));
  assert.equal(commands.length, 1);
  await act(async () => fixture.current.sendExtensionCustomInput(fixture.current.extensionCustomUi, "current"));
  assert.equal(commands.length, 2);
});

test("extension snapshots preserve newer status/widget events, including removals", async (t) => {
  const fixture = await mount(t);
  const old = fixture.runtimeGate.capture();
  await fixture.emit({ id: "status", method: "setStatus", statusKey: "job", statusText: "current" });
  await fixture.emit({ id: "widget", method: "setWidget", widgetKey: "job", widgetLines: ["current"] });
  await act(async () => fixture.current.applyExtensionSnapshot({ extensionStatuses: [], extensionWidgets: [] }, old));
  assert.deepEqual(fixture.current.extensionStatuses, [{ key: "job", text: "current" }]);
  assert.deepEqual(fixture.current.extensionWidgets[0].lines, ["current"]);
  await fixture.emit({ id: "status-remove", method: "setStatus", statusKey: "job" });
  await fixture.emit({ id: "widget-remove", method: "setWidget", widgetKey: "job" });
  assert.deepEqual(fixture.current.extensionStatuses, []);
  assert.deepEqual(fixture.current.extensionWidgets, []);
});

test("model restore notices show the requested and actual provider until an explicit selection clears them", async (t) => {
  const fixture = await mount(t);
  await act(async () =>
    fixture.current.applyExtensionSnapshot(
      {
        extensionStatuses: [],
        modelSelectionNotice: {
          requiresChoice: true,
          reason: "azure-review",
          requested: { provider: "azure-openai-responses", modelId: "gpt" },
          actual: { provider: "anthropic", modelId: "claude" },
        },
      },
      fixture.runtimeGate.capture(),
    ),
  );
  const notice = fixture.current.extensionStatuses.find((status) => status.key === "pi-model-selection");
  assert.match(notice.text, /azure-openai-responses\/gpt/);
  assert.match(notice.text, /anthropic\/claude/);
  await act(async () =>
    fixture.current.applyExtensionSnapshot(
      { extensionStatuses: [], modelSelectionNotice: undefined },
      fixture.runtimeGate.capture(),
    ),
  );
  assert.deepEqual(fixture.current.extensionStatuses, []);
});

test("notice expiry keeps the exit animation and unmount clears presentation timers", async (t) => {
  const fixture = await mount(t);
  await act(async () => fixture.current.addNotice({ id: "notice", message: "message" }));
  await fixture.advance(5000);
  assert.equal(fixture.current.notices[0].exiting, true);
  await fixture.advance(180);
  assert.deepEqual(fixture.current.notices, []);
  await fixture.emit({ id: "pending", method: "editor", title: "edit", expiresAt: 9000 });
  await act(async () => fixture.current.addNotice({ id: "pending-notice", message: "message" }));
  assert.equal(fixture.timers.size, 2);
  await fixture.unmount();
  assert.equal(fixture.timers.size, 0);
});
