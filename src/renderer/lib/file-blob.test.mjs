import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { downloadFileViaRpc, api } = await importTestBundle("file-download", {
  stdin: {
    contents: 'export {downloadFileViaRpc} from "./file-blob.ts"; export * as api from "./api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "download-api",
      setup(build) {
        build.onResolve({ filter: /^\.\/api-client$/ }, () => ({ path: "api", namespace: "download-test" }));
        build.onLoad({ filter: /.*/, namespace: "download-test" }, () => ({
          contents: `
      export const calls = [];
      export async function call(method, params) {calls.push({method, params}); return {base64: 'AP8BAg==', mime: 'application/octet-stream', size: 4};}
    `,
        }));
      },
    },
  ],
});

function fixture(t, bridge) {
  const previous = new Map(
    ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const events = [],
    anchors = [];
  api.calls.length = 0;
  globalThis.window = { piBridge: bridge };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "a");
      const anchor = { click: () => events.push("click"), remove: () => events.push("remove") };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: () => events.push("append") },
  };
  t.mock.method(URL, "createObjectURL", (blob) => {
    events.push(blob);
    return "blob:fixture";
  });
  t.mock.method(URL, "revokeObjectURL", (url) => events.push(["revoke", url]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  });
  return { events, anchors };
}

test("native save preserves authorized bytes and reveals only the successfully saved file", async (t) => {
  const saves = [],
    reveals = [];
  const f = fixture(t, {
    saveBinaryFile: async (data) => {
      saves.push(data);
      return "/saved/测试.bin";
    },
    showItemInFolder: async (path) => reveals.push(path),
  });
  await downloadFileViaRpc("/source/测试.bin", "测试.bin", "session-file");
  assert.deepEqual(api.calls, [
    { method: "files.download", params: { path: "/source/测试.bin", sourceSessionId: "session-file" } },
  ]);
  assert.deepEqual(saves, [{ base64: "AP8BAg==", defaultPath: "测试.bin" }]);
  assert.deepEqual(reveals, ["/saved/测试.bin"]);
  assert.deepEqual(f.events, []);
});

test("cancelling native save does not launch a second download or reveal a file", async (t) => {
  const f = fixture(t, {
    saveBinaryFile: async () => null,
    showItemInFolder: () => assert.fail("cancel cannot reveal"),
  });
  await downloadFileViaRpc("/source/file.bin", "file.bin");
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.anchors, []);
});

test("native save failure is reported without falling back to another save mechanism", async (t) => {
  const f = fixture(t, {
    saveBinaryFile: async () => {
      throw new Error("Disk unavailable");
    },
  });
  await assert.rejects(downloadFileViaRpc("/source/file.bin", "file.bin"), /Disk unavailable/);
  assert.deepEqual(f.events, []);
});

test("the browser fallback preserves bytes and revokes its temporary URL", async (t) => {
  const f = fixture(t);
  await downloadFileViaRpc("/source/file.bin", "file.bin");
  assert.deepEqual(new Uint8Array(await f.events[0].arrayBuffer()), Uint8Array.from([0, 255, 1, 2]));
  assert.deepEqual(f.events.slice(1), ["append", "click", "remove", ["revoke", "blob:fixture"]]);
  assert.equal(f.anchors[0].download, "file.bin");
  assert.equal(f.anchors[0].href, "blob:fixture");
});
