import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("sidebar spinner is agent-turn running, not a live TUI process", () => {
  assert.match(source, /isRunning=\{runningSessionIds\.has\((?:session|node\.session)\.id\)\}/);
  assert.match(source, /isTuiRunning=\{sessionTuiMarks\[(?:session|node\.session)\.id\] === "running"\}/);
  assert.match(source, /\{isTuiRunning && \(/);
  assert.match(source, /\{isRunning \? \(\s*<RunningSessionIndicator/);
});

test("worktree chrome portals into the cockpit input slot when provided", () => {
  assert.match(source, /worktreeSlot\?: HTMLElement \| null/);
  assert.match(source, /createPortal\(chrome, worktreeSlot\)/);
  assert.match(source, /bottom: worktreeSlot \? "calc\(100% \+ 4px\)" : undefined/);
});

test("session overflow menu is the change-cwd entry", () => {
  assert.match(source, /t\("changeWorkingDirectory",\s*"Change working directory"\)/);
  assert.match(source, /const \[relocating, setRelocating\] = useState\(false\)/);
  assert.match(source, /await relocateSession\(session\.id, dest\)/);
  assert.match(source, /onSessionRelocated\?: \(session: SessionInfo\) => void/);
});
