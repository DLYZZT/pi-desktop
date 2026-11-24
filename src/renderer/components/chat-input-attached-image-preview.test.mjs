import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const originals = {
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
  FileReader: globalThis.FileReader,
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  window: globalThis.window,
  createObjectURL: globalThis.URL.createObjectURL,
  revokeObjectURL: globalThis.URL.revokeObjectURL,
};

const storedValues = new Map();
const localStorageMock = {
  getItem(key) {
    return storedValues.get(key) ?? null;
  },
  setItem(key, value) {
    storedValues.set(key, String(value));
  },
  removeItem(key) {
    storedValues.delete(key);
  },
};

const documentMock = {
  addEventListener() {},
  removeEventListener() {},
  body: {},
  documentElement: { lang: "" },
};
const windowMock = {
  addEventListener() {},
  removeEventListener() {},
  innerHeight: 900,
  localStorage: localStorageMock,
  matchMedia() {
    return {
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    };
  },
  navigator: { language: "en-US" },
  piBridge: {
    getPathForFile() {
      return null;
    },
    async inspectLocalFiles({ paths }) {
      return paths.map((filePath) => ({ path: filePath, exists: true, isFile: true, insideCwd: false }));
    },
  },
  visualViewport: null,
};

globalThis.FileReader = class FakeFileReader {
  readAsDataURL(file) {
    this.result = file.testDataUrl;
    Promise.resolve().then(() => this.onload?.({ target: this }));
  }
};
globalThis.URL.createObjectURL = () => "blob:attached-image";
globalThis.URL.revokeObjectURL = () => {};

Object.defineProperties(globalThis, {
  cancelAnimationFrame: { configurable: true, value() {} },
  document: { configurable: true, value: documentMock },
  localStorage: { configurable: true, value: localStorageMock },
  navigator: { configurable: true, value: windowMock.navigator },
  requestAnimationFrame: {
    configurable: true,
    value(callback) {
      callback(0);
      return 1;
    },
  },
  window: { configurable: true, value: windowMock },
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { ChatInput } = await importTestBundle("src/renderer/components/chat-input-attached-image-preview", {
  stdin: {
    contents: 'export { ChatInput } from "./ChatInput.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "chat-input-attached-image-preview-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "portal-inline",
      setup(build) {
        build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom", namespace: "portal-inline" }));
        build.onLoad({ filter: /.*/, namespace: "portal-inline" }, () => ({
          contents: "export const createPortal = (children) => children;",
        }));
      },
    },
    {
      name: "file-index-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "index-test" }));
        build.onLoad({ filter: /.*/, namespace: "index-test" }, () => ({
          contents: "export async function fileIndex() { return { files: [], truncated: false }; }",
        }));
      },
    },
  ],
});

after(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (key === "createObjectURL" || key === "revokeObjectURL") continue;
    if (value === undefined) delete globalThis[key];
    else Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  globalThis.URL.createObjectURL = originals.createObjectURL;
  globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function fakeEvent(overrides = {}) {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...overrides,
  };
}

const textareaNode = {
  focus() {},
  scrollHeight: 24,
  selectionEnd: 0,
  selectionStart: 0,
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  },
  style: {},
  value: "",
};

async function mountComposer() {
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatInput, { isStreaming: false, onAbort() {}, onSend() {} }), {
      createNodeMock: (element) => (element.type === "textarea" ? textareaNode : null),
    });
  });
  return renderer;
}

test("an attached image thumbnail opens the full-size preview and closes again", async () => {
  const renderer = await mountComposer();
  try {
    const fileInput = renderer.root.find((node) => node.type === "input" && node.props.type === "file");
    await act(async () => {
      fileInput.props.onChange({
        target: {
          files: [{ type: "image/png", testDataUrl: "data:image/png;base64,aGVsbG8=" }],
          value: "",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const thumbnails = renderer.root.findAll((node) => node.type === "img" && node.props.src === "blob:attached-image");
    assert.equal(thumbnails.length, 1);
    const thumbnail = thumbnails[0];
    assert.equal(thumbnail.props.style.width, 56);
    assert.equal(thumbnail.props.style.cursor, "zoom-in");
    assert.equal(thumbnail.props["aria-label"], "View attached image");
    assert.equal(thumbnail.props.tabIndex, 0);
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);

    await act(async () => thumbnail.props.onClick(fakeEvent()));
    const dialog = renderer.root.findByProps({ role: "dialog" });
    assert.equal(dialog.props["aria-modal"], "true");
    assert.equal(dialog.findAllByType("img")[0].props.src, "blob:attached-image");

    await act(async () => dialog.props.onClick(fakeEvent()));
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally {
    await act(async () => renderer.unmount());
  }
});
