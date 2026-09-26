import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const { useSessionHistory, testApi, testPerf } = await importTestBundle("session-history-hook", {
  stdin: {
    contents:
      'export { useSessionHistory } from "./useSessionHistory.ts"; export * as testApi from "@/lib/api-client"; export * as testPerf from "@/lib/session-performance";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "history-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/(api-client|session-performance))$/ }, ({ path }) => ({
          path,
          namespace: "history-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "history-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `
          const t = (_key, fallback) => fallback;
          export function useI18n() { return { t }; }
        `
              : path === "@/lib/session-performance"
                ? `
          let sequence = 0;
          export const created = [], terminals = [];
          export const consumeSessionLoadTrace = () => { const trace = {id: String(++sequence)}; created.push(trace); return trace; };
          export const failSessionLoadTrace = (trace) => terminals.push({id: trace.id, outcome: "failed"});
          export const finishSessionLoadTrace = (trace) => terminals.push({id: trace.id, outcome: "finished"});
          export function reset() { created.length = terminals.length = 0; }
          export const markSessionLoadPhase = () => {};
          export const logSessionPerformanceEvent = () => {};
        `
                : `
          const queues = new Map();
          export const calls = [];
          export function enqueue(method, value) { const queue = queues.get(method) ?? []; queue.push(value); queues.set(method, queue); }
          async function take(method, args) {
            calls.push({method, args});
            const queue = queues.get(method);
            if (!queue?.length) throw new Error("missing fixture for " + method);
            const value = queue.shift();
            return await (typeof value === "function" ? value() : value);
          }
          export const getSession = (...args) => take("session", args);
          export const getSessionContext = (...args) => take("context", args);
          export const getSessionContextPage = (...args) => take("page", args);
          export const getSessionEntryContent = (...args) => take("content", args);
          export function reset() { queues.clear(); calls.length = 0; }
        `,
        }));
      },
    },
  ],
});

const page = (revision, id, text, previousCursor) => ({
  messages: [{ role: "user", content: text }],
  entryIds: [id],
  historyRevision: revision,
  previousCursor,
  loadedMessages: 1,
  totalMessages: 2,
  truncatedBefore: Boolean(previousCursor),
  model: null,
  thinkingLevel: "off",
});
const detail = (sid, revision, text, cursor) => ({
  sessionId: sid,
  info: { id: sid, name: text },
  leafId: `leaf-${text}`,
  tree: [],
  context: page(revision, "entry", text, cursor),
  agentState: { running: false },
});

async function mount(t) {
  testApi.reset();
  testPerf.reset();
  const previousRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const previousCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  let sequence = 0;
  const frames = new Map();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id) => frames.delete(id) });
  const sessionIdRef = { current: "a" };
  const restoredAnchors = [];
  const loaded = [];
  const options = {
    isNew: false,
    sessionIdRef,
    capturePrependAnchor: () => {
      const revision = current.historyRevision;
      return () => restoredAnchors.push(revision);
    },
    onSessionLoaded: (value) => loaded.push(value),
  };
  let current, renderer;
  function Probe() {
    current = useSessionHistory(options);
    return null;
  }
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    if (previousRaf) Object.defineProperty(globalThis, "requestAnimationFrame", previousRaf);
    else delete globalThis.requestAnimationFrame;
    if (previousCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", previousCancel);
    else delete globalThis.cancelAnimationFrame;
  });
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    loaded,
    sessionIdRef,
    restoredAnchors,
    unmount,
    async switchSession(id) {
      await act(async () => {
        sessionIdRef.current = id;
        current.resetHistory();
      });
    },
    async load(value, reset = false) {
      testApi.enqueue("session", value);
      await act(async () => current.loadSession(sessionIdRef.current, true, true, reset));
    },
    flushFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

test("newer history wins while the initial caller can still inspect its runtime snapshot", async (t) => {
  const fixture = await mount(t),
    older = createDeferred(),
    newer = createDeferred();
  testApi.enqueue("session", older.promise);
  testApi.enqueue("session", newer.promise);
  let first, second;
  await act(async () => {
    first = fixture.current.loadSession("a", true, true);
    second = fixture.current.loadSession("a");
  });
  assert.equal(fixture.current.loading, true);
  await act(async () => {
    newer.resolve(detail("a", "r2", "latest"));
    await second;
  });
  assert.equal(fixture.current.loading, false, "background refresh inherits the visible loading owner");
  const initial = { ...detail("a", "r1", "old"), agentState: { running: true, state: { isStreaming: true } } };
  let runtime;
  await act(async () => {
    older.resolve(initial);
    runtime = await first;
  });
  assert.equal(fixture.current.data.info.name, "latest");
  assert.deepEqual(fixture.current.messages, [{ role: "user", content: "latest" }]);
  assert.equal(fixture.loaded.length, 1);
  assert.equal(runtime, initial.agentState);
});

for (const failure of ["NOT_FOUND", "old request failed"]) {
  test(`a late ${failure} cannot clear a different session or its loading indicator`, async (t) => {
    const fixture = await mount(t),
      old = createDeferred(),
      next = createDeferred();
    testApi.enqueue("session", old.promise);
    let first, second;
    await act(async () => {
      first = fixture.current.loadSession("a", true);
    });
    await fixture.switchSession("b");
    testApi.enqueue("session", next.promise);
    await act(async () => {
      second = fixture.current.loadSession("b", true);
    });
    await act(async () => {
      old.reject(new Error(failure));
      await first;
    });
    assert.equal(fixture.current.loading, true);
    assert.equal(fixture.current.error, null);
    await act(async () => {
      next.resolve(detail("b", "rb", "new session"));
      await second;
    });
    assert.equal(fixture.current.data.sessionId, "b");
    assert.equal(fixture.current.loading, false);
  });
}

test("branch navigation invalidates older detail and context requests", async (t) => {
  const fixture = await mount(t);
  await fixture.load(detail("a", "r0", "base", "cursor"));
  const oldDetail = createDeferred(),
    oldContext = createDeferred(),
    nextContext = createDeferred();
  testApi.enqueue("session", oldDetail.promise);
  testApi.enqueue("context", oldContext.promise);
  testApi.enqueue("context", nextContext.promise);
  let reading, first, second;
  await act(async () => {
    reading = fixture.current.loadSession("a");
    first = fixture.current.loadContext("a", "first");
    second = fixture.current.loadContext("a", "second");
  });
  assert.equal(fixture.current.previousCursor, null, "paging waits for the selected branch context");
  await act(async () => {
    nextContext.resolve({ context: page("r2", "second", "second branch") });
    await second;
  });
  await act(async () => {
    oldDetail.resolve(detail("a", "r1", "old detail"));
    oldContext.resolve({ context: page("r1", "first", "old branch") });
    await reading;
    await first;
  });
  assert.equal(fixture.current.historyRevision, "r2");
  assert.equal(fixture.current.messages[0].content, "second branch");
});

test("failed navigation restores paging only while that navigation still owns the view", async (t) => {
  const fixture = await mount(t);
  await fixture.load(detail("a", "r1", "tail", "cursor"));
  let first, second;
  await act(async () => {
    first = fixture.current.beginNavigation();
  });
  assert.equal(fixture.current.previousCursor, null);
  await act(async () => first.cancel());
  assert.equal(fixture.current.previousCursor, "cursor");
  await act(async () => {
    first = fixture.current.beginNavigation();
    second = fixture.current.beginNavigation();
    first.cancel();
  });
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(fixture.current.previousCursor, null);
});

test("context failures are visible and a successful branch retry clears the error", async (t) => {
  const fixture = await mount(t);
  await fixture.load(detail("a", "r1", "tail", "cursor"));
  testApi.enqueue("context", () => {
    throw new Error("branch unavailable");
  });
  await act(async () => fixture.current.loadContext("a", "branch"));
  assert.equal(fixture.current.error, "branch unavailable");
  assert.equal(fixture.current.previousCursor, "cursor");
  testApi.enqueue("context", { context: page("r2", "branch", "new branch") });
  await act(async () => fixture.current.loadContext("a", "branch"));
  assert.equal(fixture.current.error, null);
  assert.equal(fixture.current.messages[0].content, "new branch");
});

test("an old page error cannot reset the newer revision or clear its page request", async (t) => {
  const fixture = await mount(t),
    old = createDeferred(),
    next = createDeferred();
  await fixture.load(detail("a", "r1", "old tail", "same-cursor"));
  testApi.enqueue("page", old.promise);
  let first, second;
  await act(async () => {
    first = fixture.current.loadOlder();
  });
  await fixture.load(detail("a", "r2", "new tail", "same-cursor"));
  testApi.enqueue("page", next.promise);
  await act(async () => {
    second = fixture.current.loadOlder();
  });
  await act(async () => {
    old.reject(new Error("STALE_CURSOR"));
    await first;
  });
  assert.equal(fixture.current.loadingOlder, true);
  assert.equal(testApi.calls.filter((call) => call.method === "session").length, 2);
  await act(async () =>
    fixture.current.updateHistory((current) => ({
      messages: [...current.messages, { role: "assistant", content: [] }],
      entryIds: [...current.entryIds, ""],
    })),
  );
  await act(async () => {
    next.resolve({ context: page("r2", "older-entry", "older") });
    await second;
  });
  assert.deepEqual(fixture.current.entryIds, ["older-entry", "entry", ""]);
  assert.equal(fixture.current.messages[1].content, "new tail");
  assert.equal(fixture.current.loadingOlder, false);
});

test("a delayed content response cannot poison a new revision's cache or delete its pending request", async (t) => {
  const fixture = await mount(t),
    old = createDeferred(),
    next = createDeferred();
  const placeholder = (revision) => {
    const result = detail("a", revision, "placeholder");
    result.context.messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "", deferredContent: { entryId: "entry", blockIndex: 0 } }],
      },
    ];
    return result;
  };
  await fixture.load(placeholder("r1"));
  testApi.enqueue("content", old.promise);
  let first, second, duplicate;
  await act(async () => {
    first = fixture.current.loadDeferredContent("entry");
  });
  await fixture.load(placeholder("r2"));
  testApi.enqueue("content", next.promise);
  await act(async () => {
    second = fixture.current.loadDeferredContent("entry");
  });
  await act(async () => {
    old.resolve({ content: { type: "text", text: "OLD" } });
    await first;
  });
  await act(async () => {
    duplicate = fixture.current.loadDeferredContent("entry");
  });
  assert.equal(testApi.calls.filter((call) => call.method === "content").length, 2);
  await act(async () => {
    next.resolve({ content: { type: "text", text: "NEW" } });
    await second;
    await duplicate;
  });
  assert.equal(fixture.current.messages[0].content[0].text, "NEW");
});

test("pagination restores its own viewport and leaves a replacement session's viewport untouched", async (t) => {
  const fixture = await mount(t);
  await fixture.load(detail("a", "r1", "tail", "cursor"));
  testApi.enqueue("page", { context: page("r1", "older", "older", "next-cursor") });
  await act(async () => fixture.current.loadOlder());
  fixture.flushFrames();
  assert.deepEqual(fixture.restoredAnchors, ["r1"]);
  testApi.enqueue("page", { context: page("r1", "oldest", "oldest") });
  await act(async () => fixture.current.loadOlder());
  await fixture.switchSession("b");
  fixture.flushFrames();
  assert.deepEqual(
    fixture.restoredAnchors,
    ["r1"],
    "a replacement session never runs the previous page's viewport callback",
  );
});

test("unmount invalidates pending detail requests without publishing metadata", async (t) => {
  const fixture = await mount(t),
    pending = createDeferred();
  testApi.enqueue("session", pending.promise);
  let reading, result;
  await act(async () => {
    reading = fixture.current.loadSession("a", true, true);
  });
  await fixture.unmount();
  await act(async () => {
    pending.resolve(detail("a", "r1", "late"));
    result = await reading;
  });
  assert.equal(result, null);
  assert.deepEqual(fixture.loaded, []);
});

test("active errors are visible and a successful retry clears them", async (t) => {
  const fixture = await mount(t);
  testApi.enqueue("session", () => {
    throw new Error("history unavailable");
  });
  await act(async () => fixture.current.loadSession("a", true));
  assert.equal(fixture.current.error, "history unavailable");
  assert.equal(fixture.current.loading, false);
  await fixture.load(detail("a", "r1", "recovered"));
  assert.equal(fixture.current.error, null);
  assert.equal(fixture.current.messages[0].content, "recovered");
});

test("replaced, painted and unmounted loads each terminate their trace exactly once", async (t) => {
  const fixture = await mount(t);
  await fixture.load(detail("a", "r1", "first"));
  await fixture.load(detail("a", "r2", "replacement"));
  fixture.flushFrames();
  fixture.flushFrames();
  const pending = createDeferred();
  testApi.enqueue("session", pending.promise);
  let request;
  await act(async () => {
    request = fixture.current.loadSession("a");
  });
  await fixture.unmount();
  await act(async () => {
    pending.resolve(detail("a", "r3", "late"));
    await request;
  });
  assert.equal(testPerf.created.length, 3);
  assert.deepEqual(
    testPerf.terminals,
    testPerf.created.map((trace, index) => ({ id: trace.id, outcome: index === 1 ? "finished" : "failed" })),
  );
});
