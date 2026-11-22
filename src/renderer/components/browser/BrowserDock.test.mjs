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
