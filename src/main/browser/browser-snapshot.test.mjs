import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import { boundInspectionSnapshot, collectBrowserSnapshot } from "./browser-snapshot.ts";

function frame({ children = [], rects = [], text = "", nodes = [], capture, ...truncation } = {}) {
  let calls = 0;
  return {
    frames: children,
    url: "https://user:secret@example.test/frame?token=secret",
    captures: 0,
    async executeJavaScript() {
      calls++;
      if (children.length && calls === 1) return rects;
      this.captures++;
      return capture ? capture() : { text, nodes, ...truncation };
    },
  };
}

function target(mainFrame) {
  const info = { id: "tab", generation: 4, title: "Fixture", url: "https://example.test/" };
  return { contents: { mainFrame }, info: () => info, timeoutMs: () => 500 };
}

function node(ref, name = ref) {
  return { ref, name, role: "button", bounds: { x: 2, y: 3, width: 20, height: 10 } };
}

test("snapshot collection preserves nested frame offsets and aligns each exposed reference with its owner", async () => {
  const nested = frame({ text: "Nested", nodes: [node("e2")] });
  const child = frame({
    children: [nested],
    rects: [{ x: 5, y: 7 }],
    text: "Child",
    nodes: [node("e1")],
  });
  const root = frame({
    children: [child],
    rects: [{ x: 10, y: 20 }],
    text: "Root",
    nodes: [node("e0")],
  });
  const result = await collectBrowserSnapshot(target(root), 10, 100, new globalThis.AbortController().signal);
  assert.equal(result.snapshot.text, "Root\nChild\nNested");
  assert.deepEqual(
    result.snapshot.nodes.map(({ bounds }) => [bounds.x, bounds.y]),
    [
      [2, 3],
      [12, 23],
      [17, 30],
    ],
  );
  assert.deepEqual([...result.state.refs], ["e0", "e1", "e2"]);
  assert.equal(result.state.id, result.snapshot.snapshotId);
  assert.equal(result.state.generation, result.snapshot.generation);
  assert.equal(result.state.frames.get("e2").frame, nested);
  assert.deepEqual(result.state.nodes.get("e2"), result.snapshot.nodes[2]);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /secret/);
  assert.equal(result.snapshot.untrustedWebContent, true);
  assert.deepEqual(result.truncated, { text: false, nodes: false });
});

test("snapshot collection reports unread frames when the node budget is reached", async () => {
  const child = frame({ text: "Hidden", nodes: [node("e1")] });
  const root = frame({ children: [child], text: "Root", nodes: [node("e0")] });
  const result = await collectBrowserSnapshot(target(root), 1, 100, new globalThis.AbortController().signal);
  assert.equal(child.captures, 0);
  assert.deepEqual([...result.state.refs], ["e0"]);
  assert.deepEqual(result.truncated, { text: true, nodes: true });
  assert.equal(result.snapshot.truncated, true);
});

test("snapshot collection tolerates an unavailable frame but rejects results from a changed generation", async () => {
  const unavailable = frame({
    capture: () => {
      throw new Error("Frame destroyed");
    },
  });
  const pending = createDeferred();
  const started = createDeferred();
  const child = frame({
    capture: () => {
      started.resolve();
      return pending.promise;
    },
  });
  const root = frame({ children: [unavailable, child], text: "Root", nodes: [node("e0")] });
  const page = target(root);
  const collecting = collectBrowserSnapshot(page, 10, 100, new globalThis.AbortController().signal);
  await started.promise;
  page.info().generation++;
  const stale = assert.rejects(
    collecting,
    (error) => error.code === "INSPECTION_STALE" && error.details.reason === "generation-changed",
  );
  pending.resolve({ text: "Old page", nodes: [node("e1")] });
  await stale;
  assert.equal(unavailable.captures, 1);
});

test("inspection projection bounds node text and total size without mutating the captured reference state", async () => {
  const result = await collectBrowserSnapshot(
    target(frame({ nodes: [node("e0", "x".repeat(600)), node("e1")] })),
    10,
    100,
    new globalThis.AbortController().signal,
  );
  const original = structuredClone(result.snapshot);
  const projected = boundInspectionSnapshot(result.snapshot, 1000);
  assert.equal(projected.snapshot.nodes[0].name.length, 300);
  const budget = JSON.stringify(projected.snapshot.nodes[0]).length;
  const limited = boundInspectionSnapshot(result.snapshot, budget);
  assert.deepEqual(
    limited.snapshot.nodes.map(({ ref }) => ref),
    ["e0"],
  );
  assert.equal(limited.nodesTruncated, true);
  assert.equal(limited.snapshot.truncated, true);
  assert.deepEqual(result.snapshot, original);
  assert.deepEqual([...result.state.refs], ["e0", "e1"]);
});
