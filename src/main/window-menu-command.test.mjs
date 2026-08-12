import assert from "node:assert/strict";
import test from "node:test";
import { sendWindowMenuCommand } from "./window-menu-command.ts";

function fixture(loading = false) {
  const calls = [];
  let destroyed = false;
  let didFinishLoad;
  const window = {
    isDestroyed: () => destroyed,
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: {
      isLoadingMainFrame: () => loading,
      once(event, listener) {
        assert.equal(event, "did-finish-load");
        didFinishLoad = listener;
      },
      send: (channel) => calls.push(`send:${channel}`),
    },
  };
  return { calls, window, finishLoad: () => didFinishLoad?.(), destroy: () => (destroyed = true) };
}

test("menu command shows and focuses a live loaded window before sending", () => {
  const state = fixture();
  sendWindowMenuCommand(() => state.window, "menu:settings");
  assert.deepEqual(state.calls, ["show", "focus", "send:menu:settings"]);
});

test("menu command waits for load and rechecks destruction before sending", () => {
  const state = fixture(true);
  sendWindowMenuCommand(() => state.window, "menu:new-session");
  assert.deepEqual(state.calls, ["show", "focus"]);
  state.destroy();
  state.finishLoad();
  assert.deepEqual(state.calls, ["show", "focus"]);
  sendWindowMenuCommand(() => null, "menu:new-session");
});
