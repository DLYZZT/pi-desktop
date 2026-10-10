import assert from "node:assert/strict";
import test from "node:test";

import {
  addKnownProjectRoot,
  KNOWN_PROJECTS_STORAGE_KEY,
  loadKnownProjectRoots,
  MAX_KNOWN_PROJECTS,
  pruneKnownProjectRoots,
  removeKnownProjectRoot,
  saveKnownProjectRoots,
} from "./known-projects.ts";

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

test("known projects round-trip through storage and tolerate malformed data", () => {
  const storage = createStorage();
  saveKnownProjectRoots(storage, ["/workspace/beta", "/workspace/alpha"]);
  assert.deepEqual(loadKnownProjectRoots(storage), ["/workspace/beta", "/workspace/alpha"]);

  storage.map.set(KNOWN_PROJECTS_STORAGE_KEY, "not json");
  assert.deepEqual(loadKnownProjectRoots(storage), []);
  storage.map.set(KNOWN_PROJECTS_STORAGE_KEY, JSON.stringify({ roots: [] }));
  assert.deepEqual(loadKnownProjectRoots(storage), []);
  storage.map.set(KNOWN_PROJECTS_STORAGE_KEY, JSON.stringify(["/workspace/beta", 7, ""]));
  assert.deepEqual(loadKnownProjectRoots(storage), ["/workspace/beta"]);

  saveKnownProjectRoots(storage, []);
  assert.equal(storage.getItem(KNOWN_PROJECTS_STORAGE_KEY), null);
});

test("re-opening a project moves it to the front and dedupes path spellings", () => {
  let roots = ["/workspace/alpha", "/workspace/beta"];
  roots = addKnownProjectRoot(roots, "/workspace/beta");
  assert.deepEqual(roots, ["/workspace/beta", "/workspace/alpha"]);

  // Separator variants name the same project and must not duplicate.
  roots = addKnownProjectRoot(roots, "/workspace\\beta");
  assert.deepEqual(
    roots.map((root) => root.replace(/\\/g, "/")),
    ["/workspace/beta", "/workspace/alpha"],
  );
});

test("the known project list stays bounded by the most recent opens", () => {
  const roots = Array.from({ length: MAX_KNOWN_PROJECTS }, (_, index) => `/workspace/p${index}`);
  const next = addKnownProjectRoot(roots, "/workspace/fresh");
  assert.equal(next.length, MAX_KNOWN_PROJECTS);
  assert.equal(next[0], "/workspace/fresh");
  assert.ok(!next.includes("/workspace/p29"));

  assert.deepEqual(addKnownProjectRoot(roots, ""), [...roots]);
});

test("pruning keeps projects that still exist and drops the rest", () => {
  const roots = ["/workspace/alpha", "/workspace/gone", "/workspace/beta"];
  assert.deepEqual(pruneKnownProjectRoots(roots, ["/workspace/beta", "/workspace/alpha"]), [
    "/workspace/alpha",
    "/workspace/beta",
  ]);
  assert.deepEqual(pruneKnownProjectRoots(roots, []), []);
});

test("removing one project keeps the others and tolerates path spellings", () => {
  const roots = ["/workspace/alpha", "/workspace/beta", "/workspace/gamma"];
  assert.deepEqual(removeKnownProjectRoot(roots, "/workspace/beta"), ["/workspace/alpha", "/workspace/gamma"]);
  assert.deepEqual(removeKnownProjectRoot(roots, "/workspace\\beta"), ["/workspace/alpha", "/workspace/gamma"]);
  assert.deepEqual(removeKnownProjectRoot(roots, "/workspace/missing"), [...roots]);
  assert.deepEqual(removeKnownProjectRoot(roots, ""), [...roots]);
});
