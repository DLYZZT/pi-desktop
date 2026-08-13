import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

test("removed unused theme tokens stay out of the global contract", () => {
  for (const token of [
    "--font-mono-font",
    "--font-sans-font",
    "--font-size-caption",
    "--font-size-control",
    "--font-size-body",
    "--control-height-compact",
  ]) {
    assert.doesNotMatch(css, new RegExp(token), token);
  }
});
