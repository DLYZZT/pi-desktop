import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./TuiDockComposer.tsx", import.meta.url), "utf8");

test("composer shows this product's dock facts, not screenshot filler", () => {
  assert.match(source, /embedded-pi-tui-dock-sheet/);
  assert.match(source, /tui-dock-bar/);
  assert.match(source, /ChangeSessionCwd/);
  assert.match(source, /appearance="pill"/);
  assert.match(source, /chrome\.usage/);
  assert.match(source, /chrome\.model/);
  assert.match(source, /chrome\.thinking/);
  assert.match(source, /chrome\.statuses/);
  assert.match(source, /onSelectModel/);
  assert.match(source, /onSelectThinking/);
  assert.match(source, /listModels/);
  assert.match(source, /tui-dock-pick-menu/);
  assert.match(source, /onHideCover/);
  assert.match(source, /extractSlashQuery/);
  assert.match(source, /\/api\/skills/);
  assert.match(source, /skill:\$\{skill\.name\}/);
  assert.match(source, /tui-dock-slash/);
  assert.doesNotMatch(source, /Do anything/);
  assert.doesNotMatch(source, />Local</);
});
