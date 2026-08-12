import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { directoryRefreshAction, shouldLoadDirectoryOnExpand } from "./directory-refresh.ts";

test("a loaded collapsed directory becomes stale and reloads on its next expansion", () => {
  assert.equal(directoryRefreshAction(false, true), "mark-stale");
  assert.equal(shouldLoadDirectoryOnExpand(false, true), true);
});

test("an open loaded directory refreshes immediately", () => {
  assert.equal(directoryRefreshAction(true, true), "reload");
  assert.equal(directoryRefreshAction(true, false), "none");
});

test("FileExplorer wires refresh planning without the dead prevLoadedRef", () => {
  const source = readFileSync(new URL("../components/FileExplorer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /prevLoadedRef/);
  assert.match(source, /const refreshAction = directoryRefreshAction\(open, loaded\)/);
  assert.match(source, /refreshAction === "mark-stale"[\s\S]*?setLoaded\(false\)[\s\S]*?setStale\(true\)/);
  assert.match(source, /shouldLoadDirectoryOnExpand\(loaded, stale\)/);
});
