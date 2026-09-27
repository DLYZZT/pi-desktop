import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const title = readFileSync(new URL("./sidebar/PiAgentTitle.tsx", import.meta.url), "utf8");
const tree = readFileSync(new URL("./sidebar/SessionTree.tsx", import.meta.url), "utf8");

const workspace = readFileSync(new URL("./sidebar/WorkspaceDropdown.tsx", import.meta.url), "utf8");
const pickers = ["ProjectPicker", "WorktreePicker"].map((name) =>
  readFileSync(new URL(`./sidebar/${name}.tsx`, import.meta.url), "utf8"),
);

test("sidebar and picker timers are released by their owning view", () => {
  assert.match(source, /if \(sessionRefreshTimerRef\.current\) clearTimeout\(sessionRefreshTimerRef\.current\)/);
  assert.match(source, /sidebarMountedRef\.current = false/);
  assert.match(source, /if \(!sidebarMountedRef\.current\) return/);
  assert.match(workspace, /const pending = timers.current/);
  assert.match(workspace, /for \(const timer of pending\) clearTimeout\(timer\)/);
  for (const picker of pickers) assert.match(picker, /const deferFocus = useDeferredFocus\(\)/);
});

test("title scramble and session item focus callbacks are cancelled on unmount", () => {
  assert.match(title, /if \(scrambleTimerRef\.current\) clearTimeout\(scrambleTimerRef\.current\)/);
  assert.match(
    tree,
    /if \(restoreFocusFrameRef\.current !== null\) window\.cancelAnimationFrame\(restoreFocusFrameRef\.current\)/,
  );
  assert.match(tree, /if \(selectInputTimerRef\.current\) clearTimeout\(selectInputTimerRef\.current\)/);
});
