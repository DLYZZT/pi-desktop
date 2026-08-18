import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

test("cockpit is one normal Electron window filling the current display work area", () => {
  assert.match(mainSource, /getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)\.workArea/);
  assert.match(mainSource, /hash: "#cockpit"/);
  assert.equal(mainSource.match(/createMainWindow\(\{/g)?.length, 1);
  assert.doesNotMatch(mainSource, /leftCockpitWindow|rightCockpitWindow|alwaysOnTop: true/);
});

test("cockpit no longer links side windows to Windows Terminal through PowerShell", () => {
  assert.doesNotMatch(mainSource, /cockpit-window-owner|session-tui-spawn|linkCockpitWindowsToSession/);
});
