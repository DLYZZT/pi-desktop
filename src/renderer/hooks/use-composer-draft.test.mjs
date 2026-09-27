import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { useComposerDraft, images } = await importTestBundle("composer-draft-owner", {
  stdin: {
    contents:
      'export {useComposerDraft} from "./useComposerDraft.ts"; export * as images from "@/lib/image-file-processing";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "draft-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(?:i18n|lib\/image-file-processing)$/ }, ({ path }) => ({
          path,
          namespace: "draft-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "draft-test" }, ({ path }) => ({
          contents:
            path === "@/i18n"
              ? "const t=(_key,fallback)=>fallback;export const useI18n=()=>({t});"
              : "let next;export function use(value){next=value;} export const processImageFileBatch=async()=>await next;",
        }));
      },
    },
  ],
});
let number = 0;
async function mount(t) {
  const key = `draft-owner-${++number}`;
  const values = new Map();
  const previous = new Map(
    ["window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let deniedKey;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === deniedKey) throw new Error("storage full");
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  globalThis.window = {
    localStorage: storage,
    piBridge: {
      getPathForFile: (file) => file.fixturePath,
      inspectLocalFiles: async ({ paths }) =>
        paths.map((path) => ({ path, exists: true, isFile: true, insideCwd: true })),
    },
  };
  globalThis.localStorage = storage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  images.use({ images: [], failures: [] });
  let replacements = 0,
    current,
    renderer;
  let props = { draftKey: key, cwd: "/fixture", onReplace: () => replacements++ };
  function Probe() {
    current = useComposerDraft(props);
    return null;
  }
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    key,
    values,
    revoked,
    unmount,
    get current() {
      return current;
    },
    get replacements() {
      return replacements;
    },
    deny(key) {
      deniedKey = `pi-desktop-draft:${key}`;
    },
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => renderer.update(createElement(Probe)));
    },
    async text(value) {
      await act(async () => current.setValue(value));
    },
    async attach() {
      images.use({ images: [{ data: "YQ==", mimeType: "image/png", previewUrl: "blob:owned" }], failures: [] });
      await act(async () => current.processFiles([{ type: "image/png", name: "fixture.png" }]));
    },
  };
}

test("ordinary owner replacement commits the exact live draft, releases previews and loads the selected owner's draft", async (t) => {
  const f = await mount(t);
  await act(async () => {
    f.current.setValue("a");
    f.current.setValue((value) => value + "b");
  });
  assert.equal(f.current.value, "ab");
  assert.equal(f.current.getRevision(), 2);
  await f.attach();
  const next = f.key + "-next";
  f.values.set(
    `pi-desktop-draft:${next}`,
    JSON.stringify({ schemaVersion: 2, value: "destination draft", images: [], files: [] }),
  );
  await f.update({ draftKey: next });
  assert.equal(f.current.value, "destination draft");
  assert.deepEqual(f.revoked, ["blob:owned"]);
  assert.equal(f.replacements, 1);
  const saved = JSON.parse(f.values.get(`pi-desktop-draft:${f.key}`));
  assert.equal(saved.value, "ab");
  assert.deepEqual(saved.images, [{ data: "YQ==", mimeType: "image/png" }]);
  assert.equal(f.current.attachedImages.length, 0);
});

test("promotion retains live text and attachments and cannot authorize a later unrelated key replacement", async (t) => {
  const f = await mount(t);
  await f.text("draft while starting");
  await f.attach();
  await act(async () =>
    f.current.processFiles([{ type: "text/plain", name: "notes.txt", fixturePath: "/fixture/notes.txt" }]),
  );
  const revision = f.current.getRevision(),
    target = f.key + "-session";
  await f.update({ draftKey: target, draftPromotionFrom: f.key });
  assert.equal(f.current.value, "draft while starting");
  assert.equal(f.current.attachedImages[0].previewUrl, "blob:owned");
  assert.equal(f.current.getRevision(), revision);
  assert.deepEqual(f.revoked, []);
  assert.equal(f.replacements, 0);
  assert.equal(f.values.has(`pi-desktop-draft:${f.key}`), false);
  assert.deepEqual(JSON.parse(f.values.get(`pi-desktop-draft:${target}`)).files, [
    { name: "notes.txt", path: "/fixture/notes.txt" },
  ]);
  await f.update({ draftKey: f.key + "-other" });
  assert.equal(f.current.value, "");
  assert.deepEqual(f.current.attachedImages, []);
  assert.equal(f.replacements, 1);
  assert.deepEqual(f.revoked, ["blob:owned"]);
});

test("a failed promotion write keeps the current draft and the previous persisted owner", async (t) => {
  const f = await mount(t);
  await f.text("recoverable draft");
  await act(async () => f.current.commitCurrentDraft());
  const target = f.key + "-denied";
  f.deny(target);
  await f.update({ draftKey: target, draftPromotionFrom: f.key });
  assert.equal(f.current.value, "recoverable draft");
  assert.match(f.current.submissionNotice, /could not be saved/);
  assert.equal(JSON.parse(f.values.get(`pi-desktop-draft:${f.key}`)).value, "recoverable draft");
  assert.equal(f.values.has(`pi-desktop-draft:${target}`), false);
});

test("a late image batch is released after unmount without publishing another draft", async (t) => {
  const f = await mount(t),
    pending = createDeferred();
  images.use(pending.promise);
  let operation;
  await act(async () => {
    operation = f.current.processFiles([{ type: "image/png", name: "late.png" }]);
  });
  await f.unmount();
  await act(async () => {
    pending.resolve({ images: [{ data: "YQ==", mimeType: "image/png", previewUrl: "blob:late" }], failures: [] });
    await operation;
  });
  assert.deepEqual(f.revoked, ["blob:late"]);
  assert.equal(f.values.has(`pi-desktop-draft:${f.key}`), false);
});
