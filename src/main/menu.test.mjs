import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { installAppMenu, state } = await importTestBundle("localized-app-menu", {
  stdin: {
    contents: 'export { installAppMenu } from "./src/main/menu.ts"; export { state } from "electron";',
    resolveDir: process.cwd(),
  },
  plugins: [
    {
      name: "native-menu-mocks",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock" }));
        build.onResolve({ filter: /\/native-language$/ }, () => ({ path: "language", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          contents:
            path === "language"
              ? 'import { state } from "electron"; export const getNativeLanguage = () => state.language;'
              : `export const state = { language: "en-US", template: [] };
             export const app = { name: "Pi Agent Desktop", getPath: () => "/logs" };
             export const shell = { openPath() {}, openExternal() {} };
             export const Menu = { buildFromTemplate: t => t, setApplicationMenu: t => { state.template = t; } };`,
          loader: "js",
        }));
      },
    },
  ],
});

function flatten(items) {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

test("all menus and role labels follow language changes without losing shortcuts or commands", () => {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    show() {},
    focus() {},
    webContents: { isLoadingMainFrame: () => false, send: (channel) => sent.push(channel) },
  };
  for (const [language, topLabels] of [
    ["zh-CN", ["文件", "编辑", "视图", "窗口", "帮助"]],
    ["zh-TW", ["檔案", "編輯", "檢視", "視窗", "說明"]],
    ["en-US", ["File", "Edit", "View", "Window", "Help"]],
  ]) {
    state.language = language;
    installAppMenu(() => window);
    assert.deepEqual(
      state.template.slice(-5).map((item) => item.label),
      topLabels,
    );
    const items = flatten(state.template);
    for (const item of items) {
      if (item.type === "separator") continue;
      assert.ok(item.label, `missing ${language} label for ${item.role}`);
      if (language !== "en-US" && item.label !== "Pi Agent Desktop") {
        assert.match(item.label, /[\u3400-\u9fff]/);
      }
    }
    items.find((item) => item.accelerator === "CmdOrCtrl+N").click();
    items.find((item) => item.accelerator === "CmdOrCtrl+K").click();
    items.find((item) => item.accelerator === "CmdOrCtrl+,").click();
    assert.equal(
      items.some((item) => item.role === "toggleDevTools"),
      false,
    );
    assert.ok(items.some((item) => item.role === "togglefullscreen"));
  }
  assert.deepEqual(
    sent,
    Array.from({ length: 3 }, () => ["menu:new-session", "menu:switch-session", "menu:settings"]).flat(),
  );
  installAppMenu(() => window, undefined, true);
  assert.ok(flatten(state.template).some((item) => item.role === "toggleDevTools"));
});
