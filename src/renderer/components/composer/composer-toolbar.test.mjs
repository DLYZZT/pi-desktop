import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ComposerToolbar, toolbarRenders } = await importTestBundle("composer-toolbar", {
  stdin: {
    contents: 'export { ComposerToolbar } from "./ComposerToolbar.tsx"; export { toolbarRenders } from "@/i18n";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "toolbar-environment",
      setup(build) {
        build.onResolve({ filter: /^(?:react-dom|@\/i18n)$/ }, ({ path }) => ({ path, namespace: "toolbar-test" }));
        build.onLoad({ filter: /.*/, namespace: "toolbar-test" }, ({ path }) => ({
          contents:
            path === "react-dom"
              ? "export const createPortal = (children) => children;"
              : "export const toolbarRenders={count:0}; const t=(_key,fallback)=>fallback; export const useI18n=()=>{toolbarRenders.count++;return {t};};",
        }));
      },
    },
  ],
});
const text = (node) => (typeof node === "string" ? node : (node?.children?.map(text).join("") ?? ""));
async function mount(t) {
  const saved = new Map(
    ["window", "document", "ResizeObserver", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const documentListeners = new Map(),
    windowListeners = new Map(),
    focused = [],
    observers = [],
    actions = [];
  function surface(listeners) {
    return {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    };
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: { ...surface(documentListeners), body: {} },
    window: { ...surface(windowListeners), innerHeight: 800, innerWidth: 1200, visualViewport: null },
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    ResizeObserver: class {
      constructor() {
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  });
  let renderer;
  let options = {
    isStreaming: false,
    model: { provider: "first", modelId: "same-id" },
    modelList: [
      { provider: "first", id: "same-id", name: "Chosen model" },
      { provider: "second", id: "same-id", name: "Other model" },
    ],
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "high"],
    toolPreset: "default",
    onModelChange: (...args) => actions.push(["model", ...args]),
    onModelsRefresh: () => actions.push(["refresh"]),
    onModelsRefreshCancel: () => actions.push(["cancel-refresh"]),
    onThinkingLevelChange: (level) => actions.push(["thinking", level]),
    onToolPresetChange: (preset) => actions.push(["permission", preset]),
    onAbort: () => actions.push(["stop"]),
  };
  const onAttach = () => actions.push(["attach"]);
  const element = () =>
    createElement(ComposerToolbar, {
      options,
      isMobile: false,
      hasAttachments: false,
      onAttach,
    });
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => {
    renderer = create(element(), {
      createNodeMock: (element) => ({
        contains: () => false,
        parentElement: {},
        getBoundingClientRect: () => ({ top: 500, left: 200, width: 180 }),
        focus: () => focused.push(element.props["aria-label"] ?? element.type),
      }),
    });
  });
  return {
    actions,
    focused,
    observers,
    documentListeners,
    windowListeners,
    unmount,
    get root() {
      return renderer.root;
    },
    async update(patch) {
      options = { ...options, ...patch };
      await act(async () => renderer.update(element()));
    },
    async clickLabel(label) {
      const button = renderer.root.find(
        (node) => node.type === "button" && node.props["aria-label"]?.startsWith(label),
      );
      await act(async () => button.props.onClick());
    },
    async clickText(label) {
      const button = renderer.root.find((node) => node.type === "button" && text(node) === label);
      await act(async () => button.props.onClick());
    },
    async dispatch(type, event) {
      await act(async () => {
        for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event);
      });
    },
  };
}

test("model menus preserve provider identity, cancel an active refresh on close and release positioning observers", async (t) => {
  const f = await mount(t);
  await f.clickText("Chosen model");
  await f.clickText("Other model");
  assert.deepEqual(f.actions, [["model", "second", "same-id"]]);
  await f.clickText("Chosen model");
  await f.clickText("Refresh model directory");
  await f.update({ modelRefreshing: true });
  await f.dispatch("mousedown", { target: {} });
  assert.deepEqual(f.actions.slice(1), [["refresh"], ["cancel-refresh"]]);
  await f.dispatch("mousedown", { target: {} });
  assert.equal(f.actions.filter((action) => action[0] === "cancel-refresh").length, 1);
  assert.ok(f.observers.every((observer) => observer.disconnected));
  await f.unmount();
  for (const listeners of [...f.documentListeners.values(), ...f.windowListeners.values()])
    assert.equal(listeners.size, 0);
});

test("control menus are exclusive, restore focus on selection or Escape and close when streaming starts", async (t) => {
  const f = await mount(t);
  const menus = () => f.root.findAll((node) => node.props.role === "menu");
  await f.clickLabel("Change reasoning level:");
  assert.equal(menus().length, 1);
  await f.clickLabel("Change permission settings:");
  assert.deepEqual(
    menus().map((menu) => menu.props["aria-label"]),
    ["Change permission settings"],
  );
  const readOnly = f.root.find((node) => node.props.role === "menuitemradio" && text(node).startsWith("Read only"));
  await act(async () => readOnly.props.onClick());
  assert.deepEqual(f.actions, [["permission", "none"]]);
  assert.match(f.focused.at(-1), /^Change permission settings:/);
  await f.clickLabel("Change reasoning level:");
  let prevented = false,
    stopped = false;
  await f.dispatch("keydown", {
    key: "Escape",
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(prevented && stopped, true);
  assert.equal(menus().length, 0);
  assert.match(f.focused.at(-1), /^Change reasoning level:/);
  await f.clickLabel("Change reasoning level:");
  await f.update({ isStreaming: true });
  assert.equal(menus().length, 0);
  assert.equal(
    f.root.find((node) => node.type === "button" && node.props["aria-label"]?.startsWith("Change reasoning level:"))
      .props.disabled,
    true,
  );
  await f.clickText("Stop");
  assert.deepEqual(f.actions.at(-1), ["stop"]);
});

test("equivalent toolbar options skip rendering without hiding real control changes", async (t) => {
  const fixture = await mount(t);
  const before = toolbarRenders.count;
  await fixture.update({});
  assert.equal(toolbarRenders.count, before);
  await fixture.update({ thinkingLevel: "high" });
  assert.equal(toolbarRenders.count, before + 1);
});
