import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_MIN_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  getKeyboardAdjustedRightPanelWidth,
  getRightPanelWidthBounds,
  loadRightPanelPreferredWidth,
  saveRightPanelPreferredWidth,
  shouldCollapseSidebarForRightPanel,
} from "./layout-preferences.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

test("loads a valid preferred width and falls back for missing or invalid values", () => {
  assert.equal(loadRightPanelPreferredWidth(createStorage()), RIGHT_PANEL_DEFAULT_WIDTH);
  assert.equal(loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "517" })), 517);
  assert.equal(
    loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "279" })),
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
  assert.equal(
    loadRightPanelPreferredWidth(createStorage({ [RIGHT_PANEL_WIDTH_STORAGE_KEY]: "not-a-number" })),
    RIGHT_PANEL_DEFAULT_WIDTH,
  );
});

test("saves a rounded usable preference without throwing on storage failures", () => {
  const storage = createStorage();
  saveRightPanelPreferredWidth(storage, 412.6);
  assert.equal(storage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY), "413");

  saveRightPanelPreferredWidth(storage, 200);
  assert.equal(storage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY), String(RIGHT_PANEL_MIN_WIDTH));

  assert.doesNotThrow(() =>
    saveRightPanelPreferredWidth(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("blocked");
        },
      },
      400,
    ),
  );
});

test("caps the panel at 40vw while preserving the chat column", () => {
  const wide = getRightPanelWidthBounds(1514, true);
  assert.equal(wide.maxWidth, Math.floor(1514 * 0.4));
  assert.ok(1514 - 280 - wide.maxWidth >= CHAT_MIN_WIDTH);

  const constrained = getRightPanelWidthBounds(1000, true);
  assert.deepEqual(constrained, { minWidth: 280, maxWidth: 300 });
  assert.equal(clampRightPanelWidth(800, 1000, true), 300);
  assert.equal(clampRightPanelWidth(100, 1000, true), 280);
});

test("allows the panel to become narrower only when the viewport cannot fit all minimums", () => {
  assert.deepEqual(getRightPanelWidthBounds(900, true), { minWidth: 200, maxWidth: 200 });
  assert.equal(clampRightPanelWidth(360, 900, true), 200);
  assert.equal(shouldCollapseSidebarForRightPanel(979), true);
  assert.equal(shouldCollapseSidebarForRightPanel(980), false);
});

test("keyboard resizing follows the separator direction and respects bounds", () => {
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowLeft", 1514, true), 376);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowRight", 1514, true), 344);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "ArrowLeft", 1514, true, true), 408);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "Home", 1514, true), 280);
  assert.equal(getKeyboardAdjustedRightPanelWidth(360, "End", 1514, true), Math.floor(1514 * 0.4));
});
