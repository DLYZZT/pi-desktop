import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { useSessionModels, testApi } = await importTestBundle("session-models-hook", {
  stdin: {
    contents: 'export { useSessionModels } from "./useSessionModels.ts"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "session-models-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/api-client)$/ }, ({ path }) => ({ path, namespace: "models-test" }));
        build.onLoad({ filter: /.*/, namespace: "models-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `
          const t = (_key, fallback) => fallback;
          export function useI18n() { return { t }; }
        `
              : `
          const lists = [], refreshes = [];
          export const listCalls = [], refreshCalls = [], cancellations = [];
          export function queueList(value) { lists.push(value); }
          export function queueRefresh(value) { refreshes.push(value); }
          const take = (queue) => {
            if (!queue.length) throw new Error("missing fixture response");
            const value = queue.shift();
            return typeof value === "function" ? value() : value;
          };
          export async function listModels(cwd) { listCalls.push(cwd); return await take(lists); }
          export async function refreshModels(cwd, requestId) { refreshCalls.push({cwd, requestId}); return await take(refreshes); }
          export async function cancelModelsRefresh(requestId) { cancellations.push(requestId); }
          export function reset() { lists.length = refreshes.length = listCalls.length = refreshCalls.length = cancellations.length = 0; }
        `,
        }));
      },
    },
  ],
});

const catalog = (id) => ({
  models: [{ id, provider: "fixture", name: `Model ${id}` }],
  defaultModel: { provider: "fixture", modelId: id },
  thinkingLevels: { [`fixture:${id}`]: ["off"] },
  catalog: { source: "cache", refreshed: false, aborted: false, warnings: [] },
});

test("an unavailable saved default never silently selects another provider for a new session", async (t) => {
  const input = catalog("available");
  input.defaultModel = { provider: "azure-openai-responses", modelId: "legacy" };
  const fixture = await mount(t, input);
  assert.equal(fixture.current.newSessionDefaultModel, null);
  await act(async () => fixture.current.setNewSessionModel({ provider: "fixture", modelId: "available" }));
  assert.deepEqual(fixture.current.newSessionModel, { provider: "fixture", modelId: "available" });
});

async function mount(t, initial = catalog("cached")) {
  testApi.reset();
  testApi.queueList(initial);
  const notices = [];
  let options = { isNew: true, cwd: "/project-one", refreshKey: 0, addNotice: (notice) => notices.push(notice) };
  let current;
  let renderer;
  function Probe() {
    current = useSessionModels(options);
    return null;
  }
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(unmount);
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    notices,
    unmount,
    async update(patch) {
      options = { ...options, ...patch };
      await act(async () => renderer.update(createElement(Probe)));
    },
  };
}

test("catalog reload updates defaults without overwriting an explicit model selection", async (t) => {
  const fixture = await mount(t);
  assert.deepEqual(fixture.current.newSessionDefaultModel, { provider: "fixture", modelId: "cached" });
  await act(async () => fixture.current.setNewSessionModel({ provider: "fixture", modelId: "chosen" }));
  testApi.queueList(catalog("next"));
  await act(async () => fixture.current.loadModels());
  assert.deepEqual(fixture.current.modelNames, { "fixture:next": "Model next" });
  assert.deepEqual(fixture.current.modelThinkingLevels, { "fixture:next": ["off"] });
  assert.equal(fixture.current.newSessionDefaultModel.modelId, "next");
  assert.equal(fixture.current.newSessionModel.modelId, "chosen");
});

test("failed reload retains cached models and reports a warning", async (t) => {
  t.mock.method(console, "error", () => {});
  const fixture = await mount(t);
  testApi.queueList(() => {
    throw new Error("directory unavailable");
  });
  await fixture.update({ refreshKey: 1 });
  assert.equal(fixture.current.modelList[0].id, "cached");
  assert.equal(fixture.notices.length, 1);
  assert.equal(fixture.notices[0].type, "warning");
  assert.match(fixture.notices[0].message, /Cached models remain available/);
});

test("an initial load failure reports the empty-catalog recovery path", async (t) => {
  t.mock.method(console, "error", () => {});
  const fixture = await mount(t, () => {
    throw new Error("offline");
  });
  assert.deepEqual(fixture.current.modelList, []);
  assert.equal(fixture.notices.length, 1);
  assert.match(fixture.notices[0].message, /check the Agent Host connection/);
});

test("a superseded read cannot publish its failure or replace a newer catalog", async (t) => {
  const fixture = await mount(t);
  const older = createDeferred(),
    newer = createDeferred();
  testApi.queueList(older.promise);
  testApi.queueList(newer.promise);
  let first, second;
  await act(async () => {
    first = fixture.current.loadModels();
    second = fixture.current.loadModels();
  });
  await act(async () => {
    newer.resolve(catalog("latest"));
    await second;
  });
  await act(async () => {
    older.reject(new Error("stale error"));
    await first;
  });
  assert.equal(fixture.current.modelList[0].id, "latest");
  assert.deepEqual(fixture.notices, []);
});

test("an aborted catalog read does not show a load-failure warning", async (t) => {
  t.mock.method(console, "error", () => {});
  const fixture = await mount(t, () => {
    throw new globalThis.DOMException("cancelled", "AbortError");
  });
  assert.deepEqual(fixture.current.modelList, []);
  assert.deepEqual(fixture.notices, []);
});

test("cancelled refresh results are discarded and an aborted read does not cancel active work", async (t) => {
  const fixture = await mount(t);
  const remote = createDeferred();
  testApi.queueRefresh(remote.promise);
  let refreshing;
  await act(async () => {
    refreshing = fixture.current.refreshModels();
  });
  const requestId = testApi.refreshCalls[0].requestId;
  assert.equal(fixture.current.modelRefreshing, true);
  await act(async () => fixture.current.loadModels(globalThis.AbortSignal.abort()));
  assert.equal(fixture.current.modelRefreshing, true);
  assert.equal(testApi.listCalls.length, 1);
  assert.deepEqual(testApi.cancellations, []);
  await act(async () => fixture.current.cancelModelRefresh());
  assert.deepEqual(testApi.cancellations, [requestId]);
  await act(async () => {
    remote.resolve(catalog("cancelled"));
    await refreshing;
  });
  assert.equal(fixture.current.modelRefreshing, false);
  assert.equal(fixture.current.modelList[0].id, "cached");
});

test("cwd changes discard old reads and unmount cancels a remote refresh", async (t) => {
  const fixture = await mount(t);
  const oldRead = createDeferred();
  testApi.queueList(oldRead.promise);
  let reading;
  await act(async () => {
    reading = fixture.current.loadModels();
  });
  testApi.queueList(catalog("project-two"));
  await fixture.update({ cwd: "/project-two" });
  await act(async () => {
    oldRead.resolve(catalog("old-project"));
    await reading;
  });
  assert.equal(fixture.current.modelList[0].id, "project-two");
  assert.equal(testApi.listCalls.at(-1), "/project-two");
  const remote = createDeferred();
  testApi.queueRefresh(remote.promise);
  let refreshing;
  await act(async () => {
    refreshing = fixture.current.refreshModels();
  });
  await fixture.unmount();
  assert.deepEqual(testApi.cancellations, [testApi.refreshCalls[0].requestId]);
  await act(async () => {
    remote.reject(new Error("late failure"));
    await refreshing;
  });
  assert.deepEqual(fixture.notices, []);
});

test("a remote refresh failure restores idle controls while preserving cached models", async (t) => {
  const fixture = await mount(t);
  testApi.queueRefresh(() => {
    throw new Error("refresh unavailable");
  });
  await act(async () => fixture.current.refreshModels());
  assert.equal(fixture.current.modelRefreshing, false);
  assert.equal(fixture.current.modelList[0].id, "cached");
  assert.equal(fixture.notices[0].type, "error");
  assert.match(fixture.notices[0].message, /Cached models remain available/);
});
