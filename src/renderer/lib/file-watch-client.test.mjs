import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { watchFile, api } = await importTestBundle("file-watch-client", {
  stdin: {
    contents: 'export {watchFile} from "./file-watch-client.ts"; export * as api from "./api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "watch-transport",
      setup(build) {
        build.onResolve({ filter: /^\.\/api-client$/ }, () => ({ path: "api", namespace: "watch-test" }));
        build.onLoad({ filter: /.*/, namespace: "watch-test" }, () => ({
          contents: `
      export const calls = [], subscriptions = [];
      let install, start;
      export function reset(options) { calls.length = subscriptions.length = 0; install = options.install; start = options.start; }
      export async function subscribe(topic, key, on) {
        const entry = {topic, key, on, released: 0}; subscriptions.push(entry);
        await install?.promise;
        return () => entry.released++;
      }
      export async function call(method, params) {
        calls.push({method, params});
        if (method === 'files.watchStart') await start?.promise;
        return {ok: true};
      }
    `,
        }));
      },
    },
  ],
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  api.reset(options);
  const statuses = [],
    changes = [],
    closes = [];
  t.after(() => closes.forEach((close) => close()));
  return {
    statuses,
    changes,
    watch(sourceSessionId = "session-one") {
      const close = watchFile("C:/测试/a #%.txt", {
        sourceSessionId,
        onStatus: (status) => statuses.push(status),
        onChange: (event) => changes.push(event),
      });
      closes.push(close);
      return close;
    },
    emit(event, index = 0) {
      api.subscriptions[index].on({ path: "C:/测试/a #%.txt", ...event });
    },
    starts: () => api.calls.filter((call) => call.method === "files.watchStart"),
    stops: () => api.calls.filter((call) => call.method === "files.watchStop"),
  };
}

test("same-path consumers preserve path and authorization while stopping only their own watch", async (t) => {
  const f = fixture(t);
  const first = f.watch(),
    second = f.watch("session-two");
  await settle();
  const starts = f.starts();
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].params.watchId, starts[1].params.watchId);
  assert.equal(starts[0].params.path, "C:/测试/a #%.txt");
  assert.deepEqual(
    starts.map((call) => call.params.sourceSessionId),
    ["session-one", "session-two"],
  );
  first();
  first();
  assert.deepEqual(f.stops(), [
    { method: "files.watchStop", params: { path: starts[0].params.path, watchId: starts[0].params.watchId } },
  ]);
  f.emit({ event: "change", size: 12 }, 1);
  f.emit({ event: "change", size: 1 }, 0);
  assert.deepEqual(
    f.changes.map((change) => change.size),
    [12],
  );
  second();
  assert.equal(api.subscriptions[0].released, 1);
  assert.equal(api.subscriptions[1].released, 1);
  assert.equal(f.stops().length, 2);
});

test("closing before subscription installation releases the late subscription without starting a watch", async (t) => {
  const install = createDeferred(),
    f = fixture(t, { install });
  const close = f.watch();
  close();
  install.resolve();
  await settle();
  assert.equal(api.subscriptions[0].released, 1);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(f.statuses, []);
});

test("closing during start immediately sends one matching stop and ignores the late acknowledgement", async (t) => {
  const start = createDeferred(),
    f = fixture(t, { start });
  const close = f.watch();
  await settle();
  close();
  assert.equal(f.stops().length, 1);
  assert.equal(f.stops()[0].params.watchId, f.starts()[0].params.watchId);
  start.resolve();
  await settle();
  f.emit({ event: "change" });
  assert.equal(f.stops().length, 1);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.changes, []);
});

test("early events are bounded and publish only after the caller's own watch authorization succeeds", async (t) => {
  const start = createDeferred(),
    f = fixture(t, { start });
  f.watch();
  await settle();
  f.emit({ event: "connected" });
  f.emit({ event: "change", size: 1 });
  f.emit({ event: "change", size: 2 });
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.changes, []);
  start.resolve();
  await settle();
  assert.deepEqual(f.statuses, [true]);
  assert.deepEqual(
    f.changes.map((event) => event.size),
    [2],
  );
  f.emit({ event: "connected" });
  f.emit({ event: "change", path: "/unrelated" });
  assert.deepEqual(f.statuses, [true]);
  assert.equal(f.changes.length, 1);
});

test("authorization failure cannot publish events from another watcher of that path", async (t) => {
  const start = createDeferred(),
    f = fixture(t, { start });
  f.watch();
  await settle();
  f.emit({ event: "connected" });
  f.emit({ event: "change", size: 999 });
  start.reject(new Error("Access denied"));
  await settle();
  assert.deepEqual(f.statuses, [false]);
  assert.deepEqual(f.changes, []);
  assert.equal(api.subscriptions[0].released, 1);
  assert.equal(f.stops().length, 1);
});

test("an error before or after acknowledgement retires the watch instead of borrowing another connection", async (t) => {
  for (const early of [true, false]) {
    const start = createDeferred(),
      f = fixture(t, { start });
    f.watch();
    await settle();
    if (!early) {
      start.resolve();
      await settle();
    }
    f.emit({ event: "error" });
    start.resolve();
    await settle();
    f.emit({ event: "connected" });
    f.emit({ event: "change" });
    assert.deepEqual(f.statuses, early ? [false] : [true, false]);
    assert.deepEqual(f.changes, []);
    assert.equal(api.subscriptions[0].released, 1);
    assert.equal(f.stops().length, 1);
  }
});

test("subscription failure is consumed without acquiring a Host lease", async (t) => {
  const install = createDeferred(),
    f = fixture(t, { install });
  f.watch();
  install.reject(new Error("Host unavailable"));
  await settle();
  assert.deepEqual(f.statuses, [false]);
  assert.deepEqual(api.calls, []);
});
