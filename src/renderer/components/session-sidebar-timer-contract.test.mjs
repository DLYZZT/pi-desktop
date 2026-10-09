import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const title = readFileSync(new URL("./sidebar/PiAgentTitle.tsx", import.meta.url), "utf8");
const tree = readFileSync(new URL("./sidebar/SessionTree.tsx", import.meta.url), "utf8");

const workspace = readFileSync(new URL("./sidebar/WorkspaceDropdown.tsx", import.meta.url), "utf8");
const projectPicker = readFileSync(new URL("./sidebar/ProjectPicker.tsx", import.meta.url), "utf8");
const worktreePicker = readFileSync(new URL("./sidebar/WorktreePicker.tsx", import.meta.url), "utf8");
// The worktree create flow moved into the shared dropdown panel; it now owns
// the deferred focus timer for the branch-name input.
const worktreePanel = readFileSync(new URL("./sidebar/WorktreeDropdownPanel.tsx", import.meta.url), "utf8");

test("sidebar and picker timers are released by their owning view", () => {
  assert.match(source, /if \(sessionRefreshTimerRef\.current\) clearTimeout\(sessionRefreshTimerRef\.current\)/);
  assert.match(source, /sidebarMountedRef\.current = false/);
  assert.match(source, /if \(!sidebarMountedRef\.current\) return/);
  assert.match(workspace, /const pending = timers.current/);
  assert.match(workspace, /for \(const timer of pending\) clearTimeout\(timer\)/);
  assert.match(projectPicker, /const deferFocus = useDeferredFocus\(\)/);
  assert.match(worktreePanel, /const deferFocus = useDeferredFocus\(\)/);
  assert.match(worktreePicker, /if \(wtGuideHintTimerRef\.current\) clearTimeout\(wtGuideHintTimerRef\.current\)/);
});

test("title scramble and session item focus callbacks are cancelled on unmount", () => {
  assert.match(title, /if \(scrambleTimerRef\.current\) clearTimeout\(scrambleTimerRef\.current\)/);
  assert.match(
    tree,
    /if \(restoreFocusFrameRef\.current !== null\) window\.cancelAnimationFrame\(restoreFocusFrameRef\.current\)/,
  );
  assert.match(tree, /if \(selectInputTimerRef\.current\) clearTimeout\(selectInputTimerRef\.current\)/);
});
