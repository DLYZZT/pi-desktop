import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "../ui/dom-test-env.mjs";

const { BrowserDeviceToolbar } = await importTestBundle("src/renderer/components/browser/device-toolbar", {
  stdin: {
    contents: 'export { BrowserDeviceToolbar } from "./BrowserDeviceToolbar.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "device-toolbar-test.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [
    inlinePortalPlugin,
    {
      name: "device-toolbar-i18n",
      setup(build) {
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "i18n-stub" }));
        build.onLoad({ filter: /.*/, namespace: "i18n-stub" }, () => ({
          contents: "export const useI18n = () => ({ t: (_key, fallback) => fallback });",
        }));
      },
    },
  ],
});

test("device controls submit custom sizes, choose presets, rotate, and toggle touch", async () => {
  const env = installDomTestEnvironment();
  const changes = [],
    popup = [];
  let renderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(BrowserDeviceToolbar, {
          device: {
            mode: "mobile",
            presetId: "galaxy-a55",
            width: 360,
            height: 800,
            dpr: 3,
            orientation: "portrait",
            touch: true,
          },
          busy: false,
          onChange: (value) => changes.push(value),
          onOpenChange: (open) => popup.push(open),
        }),
        {
          createNodeMock: () => ({
            getBoundingClientRect: () => ({ top: 0, left: 0, width: 180, bottom: 26 }),
            closest: () => null,
            contains: () => false,
            scrollIntoView() {},
            focus() {},
          }),
        },
      );
    });
    const root = renderer.root;
    const input = (name) => root.find((node) => node.type === "input" && node.props["aria-label"] === name);
    await act(async () => {
      input("Viewport width").props.onChange({ target: { value: "412" } });
      input("DPR").props.onChange({ target: { value: "2.5" } });
    });
    await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.deepEqual(changes.at(-1), { mode: "custom", width: 412, height: 800, dpr: 2.5, touch: true });
    await act(async () =>
      root.find((node) => node.type === "button" && node.props["aria-label"] === "Rotate device").props.onClick(),
    );
    assert.deepEqual(changes.at(-1), { mode: "rotate" });
    await act(async () =>
      root
        .find((node) => node.type === "input" && node.props.type === "checkbox")
        .props.onChange({ target: { checked: false } }),
    );
    assert.equal(changes.at(-1).touch, false);
    await act(async () =>
      root.find((node) => node.type === "button" && node.props["aria-label"] === "Device preset").props.onClick(),
    );
    assert.equal(popup.at(-1), true);
    await act(async () =>
      root
        .find(
          (node) =>
            node.type === "div" && node.props.role === "option" && node.props.children.at(-1) === "Google Pixel 7",
        )
        .props.onClick(),
    );
    assert.equal(changes.at(-1).presetId, "pixel-7");
    assert.equal(popup.at(-1), false);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    env.restore();
  }
});
