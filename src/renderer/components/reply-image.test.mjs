import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement, useCallback, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ReplyImage } = await importTestBundle("reply-image", {
  stdin: { contents: 'export {ReplyImage} from "./ReplyImage.tsx";', resolveDir: import.meta.dirname, loader: "tsx" },
  tsconfig: path.resolve(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "i18n",
      setup(build) {
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "reply-image" }));
        build.onLoad({ filter: /.*/, namespace: "reply-image" }, () => ({
          contents: "export const useI18n=()=>({t:(_key,fallback)=>fallback});",
        }));
      },
    },
  ],
});

test("visible reply images load original tool content automatically, with retry after a read failure", async (t) => {
  const saved = new Map(
    ["IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const observers = [],
    requests = [];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  let view;
  t.after(async () => {
    if (view) await act(async () => view.unmount());
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  });
  function Harness() {
    const [image, setImage] = useState({
      type: "image",
      source: { type: "url", url: "" },
      deferredContent: { entryId: "original-tool", blockIndex: 2, originalBytes: 700000 },
    });
    const load = useCallback(async (entryId, blockIndex) => {
      requests.push({ entryId, blockIndex });
      if (requests.length === 1) throw Error("temporary read error");
      setImage({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    }, []);
    return createElement(ReplyImage, { image, onLoad: load });
  }
  await act(async () => {
    view = create(createElement(Harness), { createNodeMock: () => ({}) });
  });
  assert.equal(requests.length, 0, "offscreen history should not fetch full image data");
  await act(async () => observers[0].callback([{ isIntersecting: false }]));
  assert.equal(requests.length, 0);
  await act(async () => observers[0].callback([{ isIntersecting: true }]));
  assert.deepEqual(requests, [{ entryId: "original-tool", blockIndex: 2 }]);
  const retry = view.root.findByType("button");
  assert.equal(retry.children.join(""), "Retry loading image");
  await act(async () => retry.props.onClick());
  assert.equal(view.root.findByType("img").props.src, "data:image/png;base64,aGVsbG8=");
  assert.equal(requests.length, 2);
  assert.equal(view.root.findAllByType("button").length, 0);
  assert.ok(observers[0].disconnected);
});
