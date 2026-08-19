import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, createRef } from "react";
import { act, create } from "react-test-renderer";

const originals = {
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  document: globalThis.document,
  fetch: globalThis.fetch,
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  window: globalThis.window,
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
    getPathForFile(file) {
      return file.testPath ?? null;
    },
    async inspectLocalFiles({ paths }) {
      return paths.map((filePath) => ({ path: filePath, exists: true, isFile: true, insideCwd: false }));
    },
  },
  visualViewport: null,
};

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

const fetchRequests = [];
globalThis.fetch = async (url) => {
  fetchRequests.push(String(url));
  return {
    ok: true,
    async json() {
      return { files: ["src/main.ts", "src/renderer/App.tsx", "README.md"], truncated: false };
    },
  };
};

const { ChatInput } = await importTestBundle("src/renderer/components/chat-input-file-reference", {
  stdin: {
    contents: 'export { ChatInput } from "./ChatInput.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "chat-input-file-reference-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

after(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function keyboardEvent(key) {
  return {
    key,
    shiftKey: false,
    nativeEvent: { isComposing: false, keyCode: key === "Enter" ? 13 : 0 },
    preventDefault() {},
  };
}

function renderedText(node) {
  return node.children.map((child) => (typeof child === "string" ? child : renderedText(child))).join("");
}

test("@ project file autocomplete survives component state and sends the completed reference", async () => {
  const sent = [];
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

  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ChatInput, {
        cwd: "/workspace/project",
        isStreaming: false,
        onAbort() {},
        onSend(message) {
          sent.push(message);
        },
      }),
      {
        createNodeMock(element) {
          return element.type === "textarea" ? textareaNode : null;
        },
      },
    );
  });

  const inputText = "@src/";
  textareaNode.value = inputText;
  textareaNode.selectionStart = inputText.length;
  textareaNode.selectionEnd = inputText.length;
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: textareaNode });
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(fetchRequests.length, 1);
  assert.match(fetchRequests[0], /^\/api\/file-index\?cwd=/);
  assert.ok(
    renderer.root
      .findAllByType("button")
      .some((button) => button.findAll((node) => node.type === "span" && node.children.includes("main.ts")).length > 0),
  );

  await act(async () => {
    renderer.root.findByType("textarea").props.onKeyDown(keyboardEvent("ArrowDown"));
  });
  await act(async () => {
    renderer.root.findByType("textarea").props.onKeyDown(keyboardEvent("Enter"));
  });
  assert.equal(renderer.root.findByType("textarea").props.value, "@src/main.ts ");
  assert.deepEqual(sent, [], "completion Enter must not submit the prompt");

  await act(async () => {
    renderer.root.findByType("textarea").props.onKeyDown(keyboardEvent("Enter"));
    await Promise.resolve();
  });
  assert.deepEqual(sent, ["@src/main.ts"]);

  await act(async () => renderer.unmount());
});

test("@ project references and absolute local file references keep their distinct wire formats", async () => {
  const sent = [];
  const handle = createRef();
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
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ChatInput, {
        cwd: "/workspace/project",
        isStreaming: false,
        onAbort() {},
        onSend(message) {
          sent.push(message);
        },
        ref: handle,
      }),
      { createNodeMock: (element) => (element.type === "textarea" ? textareaNode : null) },
    );
  });

  await act(async () => {
    handle.current.addFiles([{ name: "notes local.txt", testPath: "/tmp/notes local.txt", type: "text/plain" }]);
    await Promise.resolve();
  });
  const inputText = "@src/main.ts ";
  textareaNode.value = inputText;
  textareaNode.selectionStart = inputText.length;
  textareaNode.selectionEnd = inputText.length;
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: textareaNode });
  });
  await act(async () => {
    renderer.root.findByType("textarea").props.onKeyDown(keyboardEvent("Enter"));
    await Promise.resolve();
  });

  assert.deepEqual(sent, ["@src/main.ts [notes local.txt](file:///tmp/notes%20local.txt)"]);
  await act(async () => renderer.unmount());
});

test("streaming image queue attempts keep the complete draft in the composer", async () => {
  const draftKey = `image-queue-${Date.now()}`;
  storedValues.set(
    `pi-desktop-draft:${draftKey}`,
    JSON.stringify({
      schemaVersion: 2,
      value: "send after the current response",
      images: [{ data: "YQ==", mimeType: "image/png" }],
      files: [],
      updatedAt: Date.now(),
    }),
  );
  const queued = [];
  const textareaNode = {
    focus() {},
    scrollHeight: 24,
    selectionEnd: 0,
    selectionStart: 0,
    setSelectionRange() {},
    style: {},
    value: "send after the current response",
  };
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ChatInput, {
        draftKey,
        isStreaming: true,
        onAbort() {},
        onFollowUp(message) {
          queued.push(message);
        },
        onSend() {},
      }),
      { createNodeMock: (element) => (element.type === "textarea" ? textareaNode : null) },
    );
  });

  const followUpButton = renderer.root
    .findAllByType("button")
    .find((button) => button.children.some((child) => child === "Follow-up"));
  assert.ok(followUpButton);
  await act(async () => followUpButton.props.onClick());

  assert.deepEqual(queued, []);
  assert.equal(renderer.root.findByType("textarea").props.value, "send after the current response");
  assert.equal(renderer.root.findAllByType("img").length, 1);
  assert.ok(
    renderer.root
      .findAll((node) => node.props?.role === "alert")
      .some((node) => renderedText(node).includes("Image messages can be sent after")),
  );
  await act(async () => renderer.unmount());
});

test("a fifth image is rejected with the image limit message instead of a storage failure", async () => {
  const draftKey = `image-limit-${Date.now()}`;
  storedValues.set(
    `pi-desktop-draft:${draftKey}`,
    JSON.stringify({
      schemaVersion: 2,
      value: "",
      images: Array.from({ length: 4 }, () => ({ data: "YQ==", mimeType: "image/png" })),
      files: [],
      updatedAt: Date.now(),
    }),
  );
  const fileReaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const revoked = [];
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: class FileReaderMock {
      readAsDataURL(file) {
        this.result = `data:${file.type};base64,YQ==`;
        globalThis.queueMicrotask(() => this.onload?.());
      }
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (file) => `blob:${file.name}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url) => revoked.push(url),
  });

  const handle = createRef();
  let renderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(ChatInput, {
          draftKey,
          isStreaming: false,
          onAbort() {},
          onSend() {},
          ref: handle,
        }),
      );
    });
    await act(async () => {
      handle.current.addFiles([{ name: "fifth.png", type: "image/png" }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(renderer.root.findAllByType("img").length, 4);
    const alerts = renderer.root.findAll((node) => node.props?.role === "alert").map(renderedText);
    assert.ok(alerts.some((text) => text.includes("A draft can save up to 4 images")));
    assert.equal(
      alerts.some((text) => text.includes("could not be saved on this device")),
      false,
    );
    assert.deepEqual(revoked, ["blob:fifth.png"]);
    await act(async () => renderer.unmount());
  } finally {
    if (fileReaderDescriptor) Object.defineProperty(globalThis, "FileReader", fileReaderDescriptor);
    else delete globalThis.FileReader;
    if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    else delete URL.createObjectURL;
    if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    else delete URL.revokeObjectURL;
  }
});
