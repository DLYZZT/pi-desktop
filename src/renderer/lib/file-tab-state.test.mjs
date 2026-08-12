import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `file-tab-state-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "file-tab-state.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { reduceFileTabState } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const explorer = "explorer";
const tab = (id) => ({ id, label: `${id}.txt`, filePath: `/tmp/${id}.txt` });

test("consecutive closes reduce from the latest tabs and never select a closed id", () => {
  let state = { tabs: [tab("a"), tab("b"), tab("c")], activeTabId: "c" };
  state = reduceFileTabState(state, { type: "close", tabId: "c", fallbackTabId: explorer });
  state = reduceFileTabState(state, { type: "close", tabId: "b", fallbackTabId: explorer });
  assert.deepEqual(state, { tabs: [tab("a")], activeTabId: "a" });

  state = reduceFileTabState(state, { type: "close", tabId: "a", fallbackTabId: explorer });
  assert.deepEqual(state, { tabs: [], activeTabId: explorer });
});

test("closing an inactive tab preserves the active tab", () => {
  const state = { tabs: [tab("a"), tab("b")], activeTabId: "a" };
  assert.deepEqual(reduceFileTabState(state, { type: "close", tabId: "b", fallbackTabId: explorer }), {
    tabs: [tab("a")],
    activeTabId: "a",
  });
});

test("opening selects a tab and refreshes its source session without duplicating it", () => {
  const initial = { tabs: [], activeTabId: explorer };
  const opened = reduceFileTabState(initial, {
    type: "open",
    tab: { ...tab("a"), sourceSessionId: "session-one" },
  });
  const reopened = reduceFileTabState(opened, {
    type: "open",
    tab: { ...tab("a"), sourceSessionId: "session-two" },
  });

  assert.deepEqual(reopened, {
    tabs: [{ ...tab("a"), sourceSessionId: "session-two" }],
    activeTabId: "a",
  });
});
