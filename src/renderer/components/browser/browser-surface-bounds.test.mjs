import assert from "node:assert/strict";
import test from "node:test";
import { browserSurfaceBounds } from "./browser-surface-bounds.ts";

test("browser surface cannot cover chat when its native position lags behind the right panel", () => {
  const panel = { left: 1205, top: 24, right: 1916, bottom: 980 };
  const staleSurface = { left: 1154, top: 135, right: 1851, bottom: 954 };
  assert.deepEqual(browserSurfaceBounds(staleSurface, panel), {
    x: 1205,
    y: 135,
    width: 646,
    height: 819,
  });
});

test("browser surface keeps its full rectangle when contained and rounds inward at fractional edges", () => {
  const panel = { left: 1205.2, top: 24.1, right: 1915.8, bottom: 979.9 };
  const surface = { left: 1205.2, top: 135.1, right: 1915.8, bottom: 954.9 };
  assert.deepEqual(browserSurfaceBounds(surface, panel), {
    x: 1206,
    y: 136,
    width: 709,
    height: 818,
  });
});

test("browser surface shrinks to a safe point after leaving the panel", () => {
  const panel = { left: 1205, top: 24, right: 1916, bottom: 980 };
  const surface = { left: 100, top: 135, right: 1100, bottom: 954 };
  assert.deepEqual(browserSurfaceBounds(surface, panel), { x: 1205, y: 24, width: 1, height: 1 });
  assert.equal(browserSurfaceBounds(surface, { left: 1205, top: 24, right: 1205, bottom: 980 }), null);
});
