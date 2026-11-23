import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "../ui/dom-test-env.mjs";

const { BrowserDock } = await importTestBundle("src/renderer/components/browser/dock", {
  stdin: {
    contents: 'export { BrowserDock } from "./BrowserDock.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "dock-test.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [
    inlinePortalPlugin,
    {
      name: "browser-dock-i18n",
      setup(build) {
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "i18n-stub" }));
        build.onLoad({ filter: /.*/, namespace: "i18n-stub" }, () => ({
          contents: "export const useI18n = () => ({ t: (_key, fallback) => fallback });",
        }));
      },
    },
  ],
});

test("BrowserDock reflects Agent device events, calls the device bridge and restores its surface after menus", async () => {
  const env = installDomTestEnvironment();
  const calls = [],
    visibility = [];
  let listener, renderer;
  const tab = {
    id: "tab",
    ownerSessionId: null,
    url: "https://example.com",
    title: "Example",
    device: { mode: "desktop" },
  };
  globalThis.window.piBridge = {
    browserGetState: async () => ({
      settings: {
        settings: {
          enabled: true,
          panel: { defaultProfileId: "temporary" },
          navigation: { networkIsolation: "best-effort" },
        },
      },
      tabs: [tab],
      activeTabId: "tab",
      profiles: [{ id: "temporary", name: "Temporary" }],
      downloads: [],
      permissionRequests: [],
    }),
    onBrowserEvent(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    browserSetSurfaceVisible: async (input) => {
      visibility.push(input.visible);
    },
    browserSetDeviceMode: async (tabId, device) => {
      calls.push({ tabId, device });
      return { ...tab, device };
    },
  };
  try {
    await act(async () => {
      renderer = create(createElement(BrowserDock, { visible: true, ownerSessionId: null }));
    });
    const button = (label) =>
      renderer.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
    await act(async () => button("Device mode").props.onClick());
    assert.deepEqual(calls.at(-1), { tabId: "tab", device: { mode: "preset", presetId: "galaxy-a55" } });
    await act(async () =>
      listener({
        type: "tab-updated",
        tab: {
          ...tab,
          device: {
            mode: "mobile",
            presetId: "galaxy-a55",
            width: 360,
            height: 800,
            dpr: 3,
            orientation: "portrait",
            touch: true,
          },
        },
      }),
    );
    assert.equal(button("Exit device mode").props["aria-pressed"], true);
    assert.equal(
      renderer.root.find((node) => node.type === "input" && node.props["aria-label"] === "Viewport width").props.value,
      "360",
    );
    await act(async () => button("Rotate device").props.onClick());
    assert.deepEqual(calls.at(-1).device, { mode: "rotate" });
    await act(async () => button("More browser actions").props.onClick());
    assert.equal(visibility.at(-1), false);
    await act(async () => button("More browser actions").props.onClick());
    assert.equal(visibility.at(-1), true);
    await act(async () => button("Exit device mode").props.onClick());
    assert.deepEqual(calls.at(-1).device, { mode: "desktop" });
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    env.restore();
  }
});

test("BrowserDock never presents or drives a tab owned by another session", async () => {
  const env = installDomTestEnvironment();
  const visibility = [];
  const bounds = [];
  const activations = [];
  const created = [];
  let renderer;
  const foreign = {
    id: "foreign",
    ownerSessionId: "session-1",
    url: "http://localhost:8080/",
    title: "Local",
    device: {
      mode: "mobile",
      presetId: "galaxy-a55",
      width: 360,
      height: 800,
      dpr: 3,
      orientation: "portrait",
      touch: true,
    },
    lastActiveAt: 2,
  };
  globalThis.window.piBridge = {
    browserGetState: async () => ({
      settings: {
        settings: {
          enabled: true,
          panel: { defaultProfileId: "temporary" },
          navigation: { networkIsolation: "best-effort" },
        },
      },
      tabs: [foreign],
      activeTabId: foreign.id,
      profiles: [{ id: "temporary", name: "Temporary" }],
      downloads: [],
      permissionRequests: [],
    }),
    onBrowserEvent: () => () => undefined,
    browserSetSurfaceVisible: async (input, ownerSessionId) => {
      visibility.push({ input, ownerSessionId });
    },
    browserSetBounds: async (input) => {
      bounds.push(input);
    },
    browserActivateTab: async (...args) => {
      activations.push(args);
    },
    browserCreateUserTab: async (input) => {
      created.push(input);
      return { ...foreign, id: "mine", ownerSessionId: input.ownerSessionId, url: "https://example.com/" };
    },
  };
  try {
    await act(async () => {
      renderer = create(createElement(BrowserDock, { visible: true, ownerSessionId: "session-2" }));
    });
    const address = renderer.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Browser address",
    );
    assert.equal(address.props.value, "");
    assert.equal(
      renderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Viewport width").length,
      0,
    );
    assert.equal(bounds.length, 0);
    assert.equal(activations.length, 0);
    assert.ok(visibility.length > 0);
    assert.ok(visibility.every(({ input }) => input.tabId !== foreign.id));
    assert.equal(visibility.at(-1).ownerSessionId, "session-2");
    const openNewTab = renderer.root.find((node) => node.type === "button" && node.props.children === "Open a new tab");
    await act(async () => openNewTab.props.onClick());
    assert.deepEqual(created.at(-1), { profileId: "temporary", ownerSessionId: "session-2", activate: true });
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    env.restore();
  }
});

test("BrowserDock switches to the selected session's tab when another session owns the active tab", async () => {
  const env = installDomTestEnvironment();
  const activations = [];
  const visibility = [];
  let listener;
  let renderer;
  const foreign = {
    id: "foreign",
    ownerSessionId: "session-1",
    url: "https://foreign.example/",
    title: "Foreign",
    lastActiveAt: 3,
  };
  const mine = {
    id: "mine",
    ownerSessionId: "session-2",
    url: "https://mine.example/",
    title: "Mine",
    lastActiveAt: 7,
  };
  let activeTabId = foreign.id;
  globalThis.window.piBridge = {
    browserGetState: async () => ({
      settings: {
        settings: {
          enabled: true,
          panel: { defaultProfileId: "temporary" },
          navigation: { networkIsolation: "best-effort" },
        },
      },
      tabs: [foreign, mine],
      activeTabId,
      profiles: [{ id: "temporary", name: "Temporary" }],
      downloads: [],
      permissionRequests: [],
    }),
    onBrowserEvent: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    browserSetSurfaceVisible: async (input, ownerSessionId) => {
      visibility.push({ input, ownerSessionId });
    },
    browserSetBounds: async () => undefined,
    browserActivateTab: async (...args) => {
      activations.push(args);
    },
  };
  try {
    await act(async () => {
      renderer = create(createElement(BrowserDock, { visible: true, ownerSessionId: "session-2" }));
    });
    assert.deepEqual(activations.at(-1), ["mine", "session-2"]);
    activeTabId = mine.id;
    await act(async () => listener({ type: "active-tab-changed", tabId: mine.id }));
    const address = renderer.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Browser address",
    );
    assert.equal(address.props.value, "https://mine.example/");
    assert.ok(visibility.some(({ input }) => input.tabId === "mine" && input.visible === true));
    assert.ok(visibility.every(({ input }) => input.tabId !== foreign.id));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    env.restore();
  }
});
