import assert from "node:assert/strict";
import test from "node:test";

import { getPresetFromTools, getToolNamesForPreset, PRESET_DEFAULT, PRESET_FULL } from "./tool-presets.ts";

const tools = (activeNames) =>
  PRESET_FULL.map((name) => ({ name, description: name, active: activeNames.includes(name) }));

test("tool preset detection distinguishes none, default, full, and custom built-ins", () => {
  assert.equal(getPresetFromTools(tools([])), "none");
  assert.equal(getPresetFromTools(tools(PRESET_DEFAULT)), "default");
  assert.equal(getPresetFromTools(tools(PRESET_FULL)), "full");
  assert.equal(getPresetFromTools(tools(["read"])), "custom");
  assert.equal(getPresetFromTools(tools(PRESET_FULL.filter((name) => name !== "codemode"))), "custom");
  assert.ok(getToolNamesForPreset("full").includes("codemode"));
  assert.ok(getToolNamesForPreset("full").includes("tool_search"));
});

test("preset tool arrays are defensive copies", () => {
  const selected = getToolNamesForPreset("full");
  selected.pop();
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});
