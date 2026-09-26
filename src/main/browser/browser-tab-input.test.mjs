import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
import { createDefaultBrowserSettings } from "./browser-settings.ts";

const { BrowserTabManager } = await importTestBundle("browser-tab-input", {
  entryPoints: ["src/main/browser/browser-tab-manager.ts"],
  plugins: [
    {
      name: "mock-electron",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock-electron" }));
        build.onLoad({ filter: /.*/, namespace: "mock-electron" }, () => ({
          contents: "export class WebContentsView {}; export const nativeImage = {};",
        }));
      },
    },
  ],
});

function fixture({ windowAvailable = true } = {}) {
  const contents = new EventEmitter();
  const debuggerApi = new EventEmitter();
  Object.assign(debuggerApi, {
    isAttached: () => false,
    attach: () => {
      throw new Error("Debugger unavailable");
    },
  });
  let destroyed = false;
  const frame = {
    url: "about:blank",
    frames: [],
    async executeJavaScript() {
      return { text: "Name", nodes: [{ ref: "e0", role: "textbox", name: "Name" }] };
    },
  };
  const waiting = createDeferred();
  Object.assign(contents, {
    debugger: debuggerApi,
    mainFrame: frame,
    getURL: () => "about:blank",
    isDestroyed: () => destroyed,
    close: () => {
      destroyed = true;
    },
    setWindowOpenHandler() {},
    setUserAgent() {},
    async executeJavaScriptInIsolatedWorld() {
      waiting.resolve();
      return false;
    },
  });
  const view = { webContents: contents, setVisible() {} };
  const win = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
  const settings = createDefaultBrowserSettings();
  const session = { getUserAgent: () => "Fixture", setUserAgent() {} };
  const manager = new BrowserTabManager({
    getWindow: () => (windowAvailable ? win : null),
    getSettings: () => settings,
    getAdvancedRuntimePolicy: () => ({ enabled: false }),
    profiles: { get: () => ({ id: "temporary", mode: "temporary" }), getSession: () => session },
    createView: () => view,
    networkBodyRoot: "unused-test-directory",
    emit() {},
  });
  return { manager, contents, debuggerApi, frame, waiting };
}

test("failed debugger attachment during typing does not suppress the next local user takeover", async (t) => {
  const { manager, frame, waiting, contents } = fixture();
  t.after(() => manager.dispose());
  const tab = await manager.create({ ownerSessionId: "owner", activate: false });
  const snapshot = await manager.snapshot(tab.id, "owner");
  frame.executeJavaScript = async () => ({ x: 10, y: 20 });
  await assert.rejects(
    manager.type(tab.id, "owner", "e0", snapshot.snapshotId, snapshot.generation, "x"),
    (error) => error.code === "TAB_CRASHED" && error.cause?.message === "Debugger unavailable",
  );
  const next = manager.wait(tab.id, "owner", { condition: "text", value: "absent", timeoutMs: 500 });
  const cancelled = assert.rejects(next, (error) => error.code === "USER_TOOK_CONTROL");
  await waiting.promise;
  contents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "x" });
  await cancelled;
  assert.equal(manager.list()[0].control, "user");
});

test("creating a tab without a live window releases CDP listeners and closes its unowned view", async (t) => {
  const { manager, contents, debuggerApi } = fixture({ windowAvailable: false });
  t.after(() => manager.dispose());
  await assert.rejects(manager.create({ ownerSessionId: "owner" }), (error) => error.code === "BROWSER_DISABLED");
  assert.equal(contents.isDestroyed(), true);
  assert.deepEqual(manager.list(), []);
  assert.equal(debuggerApi.listenerCount("message"), 0);
  assert.equal(debuggerApi.listenerCount("detach"), 0);
});
