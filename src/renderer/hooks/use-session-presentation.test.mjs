import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement, StrictMode, useSyncExternalStore } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useSessionPresentation, SessionPresentationStore } = await importTestBundle("session-presentation-hook", {
  stdin: {
    contents:
      'export {useSessionPresentation} from "./useSessionPresentation.ts"; export {SessionPresentationStore} from "@/lib/session-presentation-store";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

test("multiple React consumers share a stable snapshot across updates, remount and stale cleanup", async (t) => {
  const original = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const store = new SessionPresentationStore();
  const data = (id, name) => ({ sessionId: id, info: { id, name }, stats: null, contextUsage: null });
  function Publisher({ value }) {
    useSessionPresentation(store, value);
    return null;
  }
  const snapshots = [],
    renders = [0, 0],
    roots = [];
  function Consumer({ index }) {
    snapshots[index] = useSyncExternalStore(store.subscribe, store.getSnapshot);
    renders[index]++;
    return null;
  }
  t.after(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    if (original === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = original;
  });
  let first, second;
  await act(async () => {
    roots.push(create(createElement(Consumer, { index: 0 })), create(createElement(Consumer, { index: 1 })));
    first = create(createElement(StrictMode, null, createElement(Publisher, { value: data("a", "initial") })));
    roots.push(first);
  });
  assert.equal(snapshots[0], snapshots[1]);
  const baseline = [...renders];
  await act(async () =>
    first.update(createElement(StrictMode, null, createElement(Publisher, { value: data("a", "initial") }))),
  );
  assert.deepEqual(renders, baseline);
  await act(async () => {
    second = create(createElement(Publisher, { value: data("b", "new") }));
    roots.push(second);
  });
  const current = snapshots[0];
  await act(async () => first.unmount());
  assert.equal(snapshots[0], current);
  assert.equal(snapshots[1], current);
  await act(async () => second.unmount());
  assert.equal(snapshots[0], null);
  assert.equal(snapshots[1], null);
});
