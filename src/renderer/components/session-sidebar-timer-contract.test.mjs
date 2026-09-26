import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const title = readFileSync(new URL("./sidebar/PiAgentTitle.tsx", import.meta.url), "utf8");
const tree = readFileSync(new URL("./sidebar/SessionTree.tsx", import.meta.url), "utf8");

test("SessionSidebar owns refresh and deferred focus timers until unmount", () => {
  assert.match(source, /if \(sessionRefreshTimerRef\.current\) clearTimeout\(sessionRefreshTimerRef\.current\)/);
  assert.match(source, /sidebarMountedRef\.current = false/);
  assert.match(source, /if \(!sidebarMountedRef\.current\) return/);
  assert.match(source, /const deferredFocusTimers = deferredFocusTimersRef\.current/);
  assert.match(source, /for \(const timer of deferredFocusTimers\) clearTimeout\(timer\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => customPathInputRef\.current\?\.focus\(\), 0\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => wtNewInputRef\.current\?\.focus\(\), 0\)/);
});

test("title scramble and session item focus callbacks are cancelled on unmount", () => {
  assert.match(title, /if \(scrambleTimerRef\.current\) clearTimeout\(scrambleTimerRef\.current\)/);
  assert.match(
    tree,
    /if \(restoreFocusFrameRef\.current !== null\) window\.cancelAnimationFrame\(restoreFocusFrameRef\.current\)/,
  );
  assert.match(tree, /if \(selectInputTimerRef\.current\) clearTimeout\(selectInputTimerRef\.current\)/);
});
