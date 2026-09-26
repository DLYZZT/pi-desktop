import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const { FileViewer, api } = await importTestBundle("file-viewer", {
  stdin: {
    contents: 'export {FileViewer} from "./FileViewer.tsx"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*", "mammoth"],
  plugins: [
    {
      name: "viewer-fixture",
      setup(build) {
        const stubs = {
          "@/i18n": 'const t = (_key, fallback) => fallback; export const useI18n = () => ({t, language: "en"});',
          "@/hooks/useTheme": "export const useTheme = () => ({isDark: false});",
          "@/lib/syntax-highlight":
            'import {createElement} from "react"; export const SyntaxHighlighter = ({children}) => createElement("pre", null, children); export const vs = {}, vscDarkPlus = {};',
          "./MarkdownBody":
            'import {createElement} from "react"; export const MarkdownBody = ({children}) => createElement("div", null, children);',
          api: `
        export const reads = [], watches = [], subscriptions = [];
        export function reset() {reads.length = watches.length = subscriptions.length = 0;}
        export async function call(method, params) {
          if(method === "files.read") return new Promise((resolve, reject) => reads.push({params, resolve, reject}));
          if(method.startsWith("files.watch")) {watches.push({method, params}); return {ok: true};}
          throw new Error("Unexpected method " + method);
        }
        export async function subscribe(topic, key, on) {
          const sub = {topic, key, on, released: 0}; subscriptions.push(sub); return () => sub.released++;
        }
      `,
        };
        build.onResolve({ filter: /^(?:@\/|\.\/)/ }, ({ path }) => {
          const key = /^(?:@\/lib\/|\.\/)api-client$/.test(path) ? "api" : path;
          return stubs[key] ? { path: key, namespace: "viewer-test" } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "viewer-test" }, ({ path }) => ({ contents: stubs[path] }));
      },
    },
  ],
});

async function mount(t, initial) {
  api.reset();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  globalThis.EventSource = class {
    constructor() {
      throw new Error("FileViewer cannot use the legacy stream");
    }
  };
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("FileViewer cannot use legacy fetch");
  });
  let props = { filePath: "/project/a.txt", sourceSessionId: "session-a", ...initial },
    renderer;
  await act(async () => {
    renderer = create(createElement(FileViewer, props));
  });
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    if (previous) Object.defineProperty(globalThis, "EventSource", previous);
    else delete globalThis.EventSource;
  });
  return {
    text: () => JSON.stringify(renderer.toJSON()),
    unmount,
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => renderer.update(createElement(FileViewer, props)));
    },
    async reply(index, content) {
      await act(async () =>
        api.reads[index].resolve(
          typeof content === "string" ? { content, language: "text", size: content.length } : content,
        ),
      );
    },
    async emit(index, event) {
      await act(async () => api.subscriptions[index].on({ path: api.subscriptions[index].key, ...event }));
    },
  };
}

test("text preview refreshes through RPC and discards old path reads and streams after a switch", async (t) => {
  const f = await mount(t);
  assert.deepEqual(api.reads[0].params, { path: "/project/a.txt", sourceSessionId: "session-a" });
  await f.reply(0, "first content");
  assert.match(f.text(), /first content/);
  assert.match(f.text(), /Live sync active/);
  await f.emit(0, { event: "change" });
  await f.reply(1, "updated content");
  assert.match(f.text(), /updated content/);
  await f.emit(0, { event: "change" });
  await f.update({ filePath: "/second/b.txt", sourceSessionId: "session-b" });
  assert.equal(api.subscriptions[0].released, 1);
  await f.reply(3, "new workspace");
  await f.reply(2, "late old workspace");
  await f.emit(0, { event: "change" });
  assert.equal(api.reads.length, 4);
  assert.match(f.text(), /new workspace/);
  assert.doesNotMatch(f.text(), /late old workspace/);
  assert.deepEqual(api.reads[3].params, { path: "/second/b.txt", sourceSessionId: "session-b" });
  await f.unmount();
  assert.equal(api.subscriptions[1].released, 1);
  assert.equal(api.watches.filter((watch) => watch.method === "files.watchStop").length, 2);
});

test("binary preview reloads on change, releases blob URLs, and stays static after watch failure", async (t) => {
  const blobs = [],
    revoked = [];
  t.mock.method(URL, "createObjectURL", (blob) => {
    blobs.push(blob);
    return `blob:fixture-${blobs.length}`;
  });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const f = await mount(t, { filePath: "/project/image.png" });
  const content = { content: "AAEC", encoding: "base64", mime: "image/png", size: 3 };
  await f.reply(0, content);
  assert.match(f.text(), /blob:fixture-1/);
  await f.emit(0, { event: "change", size: 4 });
  await f.reply(1, { ...content, content: "AAECAw==", size: 4 });
  assert.deepEqual(revoked, ["blob:fixture-1"]);
  assert.match(f.text(), /blob:fixture-2/);
  await f.emit(0, { event: "error" });
  await f.emit(0, { event: "connected" });
  await f.emit(0, { event: "change" });
  assert.match(f.text(), /Not watching/);
  assert.equal(api.reads.length, 2);
  await f.unmount();
  assert.deepEqual(revoked, ["blob:fixture-1", "blob:fixture-2"]);
});
