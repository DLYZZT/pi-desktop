import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useHerdrFleet, useHerdrRuntime, testApi } = await importTestBundle("src/renderer/hooks/herdr-hooks", {
  stdin: {
    contents:
      'export { useHerdrRuntime } from "./useHerdrRuntime.ts"; export { useHerdrFleet } from "./useHerdrFleet.ts"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    sourcefile: "herdr-hooks-test-entry.ts",
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "stub-herdr-api",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({
          path: "api-client",
          namespace: "herdr-hooks-test",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "herdr-hooks-test" }, () => ({
          loader: "js",
          contents: `
            const queues = new Map();
            const listeners = new Map();
            export function queueResult(method, value) {
              const values = queues.get(method) || [];
              values.push(value);
              queues.set(method, values);
            }
            export async function call(method) {
              const values = queues.get(method) || [];
              if (values.length === 0) throw new Error("missing queued result for " + method);
              return await values.shift();
            }
            export function subscribe(topic, _key, listener) {
              listeners.set(topic, listener);
              return Promise.resolve(() => listeners.delete(topic));
            }
            export function emit(topic, value) { listeners.get(topic)?.(value); }
            export function reset() { queues.clear(); listeners.clear(); }
          `,
        }));
      },
    },
  ],
});

after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const runtime = (revision) => ({
  status: "ready",
  mode: "attach",
  version: "0.8.2",
  releaseControlOnViewClose: true,
  capabilities: {
    readOnly: true,
    agentControl: true,
    terminalObserve: true,
    terminalControl: true,
    ansiOnly: true,
    graphics: false,
  },
  sourceGeneration: 4,
  descriptorRevision: revision,
  revision,
  receivedAt: revision,
});

const fleet = (revision) => ({
  sourceGeneration: 4,
  revision,
  receivedAt: revision,
  stale: false,
  workspaces: [{ id: "w1", tabs: [] }],
  panes: [{ id: "p1", workspaceId: "w1", tabId: "t1", alive: true }],
});

test("runtime stream revision 9 cannot be rolled back by a late refresh revision 8", async () => {
  testApi.reset();
  let releaseRefresh;
  testApi.queueResult(
    "herdr.runtime.get",
    new Promise((resolve) => {
      releaseRefresh = () => resolve(runtime(8));
    }),
  );
  let latest;
  function Probe() {
    latest = useHerdrRuntime();
    return null;
  }
  let renderer;
  await act(async () => {
    renderer = create(createElement(Probe));
    await Promise.resolve();
  });
  await act(async () => testApi.emit("herdr.runtime", runtime(9)));
  await act(async () => releaseRefresh());
  assert.equal(latest.runtime.revision, 9);
  assert.equal(latest.loading, false);
  await act(async () => renderer.unmount());
});

test("disabling the Fleet hook retains the last snapshot and marks it stale", async () => {
  testApi.reset();
  testApi.queueResult("herdr.snapshot", fleet(3));
  let latest;
  function Probe({ enabled }) {
    latest = useHerdrFleet(enabled);
    return null;
  }
  let renderer;
  await act(async () => {
    renderer = create(createElement(Probe, { enabled: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(latest.fleet.stale, false);
  await act(async () => renderer.update(createElement(Probe, { enabled: false })));
  assert.equal(latest.fleet.stale, true);
  assert.deepEqual(latest.fleet.workspaces, fleet(3).workspaces);
  assert.deepEqual(latest.fleet.panes, fleet(3).panes);
  await act(async () => renderer.unmount());
});
