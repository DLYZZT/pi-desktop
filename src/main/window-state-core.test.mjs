import assert from "node:assert/strict";
import test from "node:test";
import { persistableWindowState, resolveWindowBounds } from "./window-state-core.ts";

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const secondary = { x: 1920, y: 0, width: 1600, height: 900 };

test("persists only finite normal bounds from a normal or maximized window", () => {
  let normalBoundsReads = 0;
  const state = persistableWindowState({
    isDestroyed: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    isMaximized: () => true,
    getNormalBounds() {
      normalBoundsReads += 1;
      return { x: 120, y: 80, width: 1280, height: 840 };
    },
  });

  assert.deepEqual(state, { x: 120, y: 80, width: 1280, height: 840, isMaximized: true });
  assert.equal(normalBoundsReads, 1);
  assert.equal(
    persistableWindowState({
      isDestroyed: () => false,
      isMinimized: () => true,
      isFullScreen: () => false,
      isMaximized: () => false,
      getNormalBounds: () => ({ x: -32_000, y: -32_000, width: 1280, height: 840 }),
    }),
    undefined,
  );
});

test("recenters Windows minimized sentinel and disconnected-display bounds", () => {
  const defaults = { width: 1280, height: 840 };
  const displays = { primary, all: [primary] };

  assert.deepEqual(resolveWindowBounds(defaults, { x: -32_000, y: -32_000, width: 1280, height: 840 }, displays), {
    x: 320,
    y: 120,
    width: 1280,
    height: 840,
  });
  assert.deepEqual(resolveWindowBounds(defaults, { x: 2_200, y: 100, width: 1200, height: 700 }, displays), {
    x: 360,
    y: 190,
    width: 1200,
    height: 700,
  });
});

test("keeps visible secondary-display placement and clamps oversized bounds", () => {
  const defaults = { width: 1280, height: 840 };

  assert.deepEqual(
    resolveWindowBounds(
      defaults,
      { x: 2_100, y: 50, width: 1200, height: 700 },
      {
        primary,
        all: [primary, secondary],
      },
    ),
    { x: 2_100, y: 50, width: 1200, height: 700 },
  );
  assert.deepEqual(
    resolveWindowBounds(
      defaults,
      { x: 2_000, y: 20, width: 5_000, height: 4_000 },
      {
        primary,
        all: [primary, secondary],
      },
    ),
    { x: 2_000, y: 20, width: 1600, height: 900 },
  );
});
