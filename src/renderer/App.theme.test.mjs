import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("App startup and crash surfaces use live theme and shared font tokens", () => {
  for (const token of [
    "var(--bg)",
    "var(--bg-panel)",
    "var(--border)",
    "var(--text)",
    "var(--text-muted)",
    "var(--text-dim)",
    "var(--font-sans)",
    "var(--font-mono)",
    "var(--tool-bg)",
    "var(--tool-fg)",
  ]) {
    assert.ok(source.includes(token), token);
  }

  for (const staleValue of ["Inter, system-ui, sans-serif", "ui-monospace, monospace", "#f7f6f3", "#fcfbf9"])
    assert.doesNotMatch(source, new RegExp(staleValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
