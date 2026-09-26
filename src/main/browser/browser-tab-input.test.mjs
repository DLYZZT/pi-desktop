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

test("failed debugger attachment during typing does not suppress the next local user takeover", async (t) => {
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
    getWindow: () => win,
    getSettings: () => settings,
    getAdvancedRuntimePolicy: () => ({ enabled: false }),
    profiles: { get: () => ({ id: "temporary", mode: "temporary" }), getSession: () => session },
    createView: () => view,
    networkBodyRoot: "unused-test-directory",
    emit() {},
  });
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
