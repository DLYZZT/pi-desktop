import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentFiles = [
  "components/FileViewer.tsx",
  "components/channels/ChannelsConfig.tsx",
  "components/ChatInput.tsx",
  "components/PluginsConfig.tsx",
  "components/ToolchainsConfig.tsx",
  "components/MessageView.tsx",
];

test("status colors in planned component owners use semantic theme tokens", () => {
  const forbiddenStatusHex = ["#f87171", "#ef4444", "#4ade80", "#22c55e", "#f59e0b", "#d97706", "#16a34a", "#1f2937"];
  for (const file of componentFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const hex of forbiddenStatusHex) assert.doesNotMatch(source, new RegExp(hex, "i"), `${file}: ${hex}`);
  }
});

test("ModelsConfig connection-test badge and button use theme semantic colors", () => {
  const source = readFileSync(new URL("components/ModelsConfig.tsx", import.meta.url), "utf8");
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail("),
    source.indexOf("function ManagedModelsControl("),
  );
  const testUi = modelDetail.slice(modelDetail.indexOf("{testSummary &&"), modelDetail.indexOf("onClick={onDelete}"));

  assert.ok(testUi.length > 0, "connection-test UI source");
  for (const token of [
    "var(--danger-border)",
    "var(--success-border)",
    "var(--danger-soft)",
    "var(--success-soft)",
    "var(--danger)",
    "var(--success)",
    "var(--on-accent)",
  ]) {
    assert.match(testUi, new RegExp(token.replace(/[()]/g, "\\$&")), token);
  }
  assert.doesNotMatch(testUi, /#(?:fecaca|bbf7d0|fee2e2|dcfce7|e5e7eb|111827|16a34a|fff)\b/i);
});

test("light and dark themes define the complete semantic color contract", () => {
  const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  const roots = [css.slice(css.indexOf(":root {"), css.indexOf("html.dark")), css.slice(css.indexOf("html.dark"))];
  for (const root of roots) {
    for (const token of [
      "--success",
      "--success-soft",
      "--success-border",
      "--danger",
      "--danger-soft",
      "--danger-border",
      "--warning",
      "--warning-soft",
      "--warning-border",
      "--info",
      "--info-soft",
      "--info-border",
      "--on-accent",
    ]) {
      assert.match(root, new RegExp(`${token}:`), token);
    }
  }
});
