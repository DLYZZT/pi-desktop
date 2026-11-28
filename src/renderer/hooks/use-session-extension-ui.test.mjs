import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useSessionExtensionUi, SessionRuntimeGate, commands, draftUpdates } = await importTestBundle(
  "session-extension-ui",
  {
    stdin: {
      contents:
        'export {useSessionExtensionUi} from "./useSessionExtensionUi.ts"; export {SessionRuntimeGate} from "@/lib/session-runtime-gate"; export {commands, draftUpdates} from "@/lib/agent-client";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
    external: ["react", "react-dom", "react-dom/*"],
    plugins: [
      {
        name: "extension-commands",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/(?:agent|api)-client$/ }, () => ({
            path: "fixture",
            namespace: "extension-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "extension-test" }, () => ({
            loader: "js",
            contents: `
      export const commands = [];
      export const draftUpdates = [];
      export async function syncEditorDraft(update) { draftUpdates.push(update); return null; }
      export async function sendAgentCommand(sid, command) { commands.push({sid, command}); return {}; }
    `,
          }));
        },
      },
    ],
  },
);

async function mount(t) {
  commands.length = 0;
  draftUpdates.length = 0;
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
  let draft = { text: "old draft", start: 0, end: 3 };
  const options = {
    sessionIdRef,
    runtimeGate,
    getViewSignal: () => controller.signal,
    chatInputRef: {
      current: {
        getEditorDraft: () => draft,
        applyEditorDraft: (next) => {
          draft = next;
          inserted.push(next.text);
        },
      },
    },
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

test("extension paste uses the selection; replace and clear apply once across replay and sync the actual draft", async (t) => {
  const f = await mount(t);
  const version = (sequence) => ({ instance: "host", sequence });
  const edit = (method, text, sequence) =>
    f.emit({ method, text, editorVersion: version(sequence), id: String(sequence) });
  await edit("paste_editor_text", "new", 1);
  assert.deepEqual(draftUpdates.at(-1).draft, { text: "new draft", start: 3, end: 3 });
  await edit("paste_editor_text", "!", 2);
  await edit("set_editor_text", "replacement", 3);
  await edit("set_editor_text", "", 4);
  await f.emit({
    id: "replay",
    method: "restore_editor_draft",
    edit: { version: version(3), draft: { text: "old", start: 0, end: 0 } },
  });
  await edit("set_editor_text", "", 4);
  assert.deepEqual(f.inserted, ["new draft", "new! draft", "replacement", ""]);
  assert.deepEqual(draftUpdates.at(-1).applied, version(4));
  assert.deepEqual(draftUpdates.at(-1).draft, { text: "", start: 0, end: 0 });
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

test("an older Host's unmatched picker entries do not become toasts on live delivery or snapshot replay", async (t) => {
  const fixture = await mount(t);
  fixture.sessionIdRef.current = "legacy-scope";
  const [live, replay, truncated] = [
    "github-copilot/claude-fable-5",
    "nvidia/meta/llama-3.2-90b-vision-instruct",
    "example/" + "a".repeat(250),
  ].map((pattern) => {
    const message = `No models match pattern "${pattern}"`;
    return {
      key: "pi-runtime-warning-" + createHash("sha256").update(message).digest("hex").slice(0, 24),
      text: message.slice(0, 240),
    };
  });
  await fixture.emit({ id: "legacy-live", method: "setStatus", statusKey: live.key, statusText: live.text });
  await act(async () =>
    fixture.current.applyExtensionSnapshot(
      { extensionStatuses: [live, replay, truncated] },
      fixture.runtimeGate.capture(),
    ),
  );
  assert.deepEqual(fixture.current.notices, []);
  assert.deepEqual(fixture.current.extensionStatuses, []);

  await fixture.emit({ id: "extension", method: "notify", notifyType: "warning", message: live.text });
  await fixture.emit({
    id: "error",
    method: "setStatus",
    statusKey: live.key.replace("warning", "error"),
    statusText: live.text,
  });
  assert.deepEqual(
    fixture.current.notices.map(({ message, type }) => [message, type]),
    [
      [live.text, "warning"],
      [live.text, "error"],
    ],
  );
});

test("runtime diagnostics are announced once across events and snapshots without occupying the status bar", async (t) => {
  const fixture = await mount(t);
  const request = {
    method: "setStatus",
    id: "diag",
    statusKey: "pi-runtime-warning-6473799b1aa68430ab2a7d9a",
    statusText: "Example diagnostic",
  };
  const diagnostic = { key: request.statusKey, text: request.statusText };
  const extension = { key: "pi-runtime-warning-build", text: "Build running" };
  const ticket = fixture.runtimeGate.capture();
  await fixture.emit(request);
  await act(async () => fixture.current.applyExtensionSnapshot({ extensionStatuses: [diagnostic, extension] }, ticket));
  assert.deepEqual(
    fixture.current.notices.map(({ message, type }) => ({ message, type })),
    [{ message: request.statusText, type: "warning" }],
  );
  assert.deepEqual(fixture.current.extensionStatuses, [extension]);
  await fixture.advance(15000);
  await fixture.advance(500);
  assert.equal(fixture.current.notices.length, 0);
  await act(async () =>
    fixture.current.applyExtensionSnapshot(
      { extensionStatuses: [diagnostic, extension] },
      fixture.runtimeGate.capture(),
    ),
  );
  await fixture.emit({ ...request, id: "again" });
  assert.equal(fixture.current.notices.length, 0);
  const second = { key: "pi-runtime-error-d29b51da28af29e1ce3410e8", text: "Another diagnostic" };
  const nextTicket = fixture.runtimeGate.capture();
  await fixture.emit({ ...request, statusKey: extension.key, statusText: "Build finished" });
  await act(async () => fixture.current.applyExtensionSnapshot({ extensionStatuses: [second, extension] }, nextTicket));
  assert.deepEqual(fixture.current.extensionStatuses, [{ ...extension, text: "Build finished" }]);
  assert.deepEqual(
    fixture.current.notices.map(({ message, type }) => ({ message, type })),
    [{ message: second.text, type: "error" }],
  );
});

test("clearing a diagnostic during a snapshot preserves unrelated diagnostics and the model choice prompt", async (t) => {
  const fixture = await mount(t);
  const cleared = { key: "pi-runtime-warning-" + "a".repeat(24), text: "Cleared" };
  const current = { key: "pi-runtime-error-" + "b".repeat(24), text: "Extension failed" };
  const snapshot = {
    extensionStatuses: [cleared, current],
    modelSelectionNotice: {
      requiresChoice: true,
      reason: "restore-fallback",
      requested: { provider: "example", modelId: "retired" },
    },
  };
  const pending = fixture.runtimeGate.capture();
  await fixture.emit({ method: "setStatus", id: "clear", statusKey: cleared.key });
  await act(async () => fixture.current.applyExtensionSnapshot(snapshot, pending));
  assert.deepEqual(
    fixture.current.notices.map((notice) => notice.message),
    [current.text],
  );
  assert.equal(fixture.current.extensionStatuses.length, 1);
  assert.match(fixture.current.extensionStatuses[0].text, /example\/retired/);
  await act(async () => fixture.current.applyExtensionSnapshot(snapshot, fixture.runtimeGate.capture()));
  assert.deepEqual(
    fixture.current.notices.map((notice) => notice.message),
    [current.text, cleared.text],
  );
});

test("returning to a chat restores pending dialogs in order without reviving answers or extending deadlines", async (t) => {
  const f = await mount(t);
  const make = (id, expiresAt) => ({
    type: "extension_ui_request",
    method: "confirm",
    title: id,
    message: id,
    id,
    expiresAt,
  });
  const a = make("a", 1500),
    b = make("b", 1600);
  const old = f.runtimeGate.capture();
  await f.emit(b);
  await act(async () => f.current.applyExtensionSnapshot({ pendingDialogs: [a] }, old));
  assert.equal(f.current.extensionDialog.id, "b");
  const stale = f.runtimeGate.capture();
  await f.emit({ method: "dialog_closed", id: "b" });
  assert.equal(f.current.extensionDialog.id, "a");
  await act(async () => f.current.applyExtensionSnapshot({ pendingDialogs: [a, b] }, stale));
  assert.equal(f.current.extensionDialog.id, "a");
  await act(async () => f.current.respondToExtensionUi(f.current.extensionDialog, { confirmed: true }));
  await f.emit(a);
  assert.equal(f.current.extensionDialog, null);
  const expiring = make("c", 1250);
  await f.advance(150);
  await act(async () => f.current.applyExtensionSnapshot({ pendingDialogs: [expiring] }, f.runtimeGate.capture()));
  assert.equal(f.current.extensionDialog.id, "c");
  await f.advance(100);
  assert.equal(f.current.extensionDialog, null);
  assert.equal(commands.length, 1);
});

test("an older nonempty snapshot cannot supersede a newer empty snapshot", async (t) => {
  const f = await mount(t);
  const old = f.runtimeGate.capture();
  await act(async () => f.current.applyExtensionSnapshot({ pendingDialogs: [] }, f.runtimeGate.capture()));
  await act(async () =>
    f.current.applyExtensionSnapshot(
      { pendingDialogs: [{ type: "extension_ui_request", method: "confirm", id: "stale", title: "?", message: "?" }] },
      old,
    ),
  );
  assert.equal(f.current.extensionDialog, null);
});

test("an authoritative empty dialog snapshot also invalidates delayed live replay", async (t) => {
  const f = await mount(t);
  const stale = { id: "closed-while-away", method: "editor", title: "Old input" };
  await f.emit(stale);
  await act(async () => f.current.applyExtensionSnapshot({ pendingDialogs: [] }, f.runtimeGate.capture()));
  await f.emit(stale);
  assert.equal(f.current.extensionDialog, null);
});
