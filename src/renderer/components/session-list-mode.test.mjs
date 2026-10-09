import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const group = readFileSync(new URL("./sidebar/ProjectSessionGroup.tsx", import.meta.url), "utf8");
const branchMenu = readFileSync(new URL("./sidebar/ProjectBranchMenu.tsx", import.meta.url), "utf8");
const worktreePanel = readFileSync(new URL("./sidebar/WorktreeDropdownPanel.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./sidebar/ProjectPicker.tsx", import.meta.url), "utf8");
const settingsSection = readFileSync(new URL("./settings/SessionListSettings.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../lib/session-list-mode.ts", import.meta.url), "utf8");
const contract = readFileSync(new URL("../../contract/desktop.ts", import.meta.url), "utf8");
const patchValidator = readFileSync(new URL("../../main/ui-state-patch.ts", import.meta.url), "utf8");

test("aggregated mode groups sessions by project while independent mode keeps date groups", () => {
  assert.match(sidebar, /groupSessionsByProject\(filteredSessions\)/);
  assert.match(sidebar, /aggregated \? allSessions : projectSessions/);
  // Independent mode keeps the historical date-group rendering untouched.
  assert.match(sidebar, /sessionGroups\.map\(/);
  assert.match(sidebar, /<ProjectSessionGroup/);
  assert.match(group, /role="list"/);
});

test("aggregated mode replaces the top-level controls with a project opener", () => {
  // New session, project picker and worktree picker only render in independent mode.
  assert.match(sidebar, /\{aggregated \? \(/);
  assert.match(sidebar, /<ProjectPicker\s+compact/);
  // The else branch of the same ternary keeps the historical controls.
  assert.match(sidebar, /\) : \(\s*<>\s*<button[\s\S]{0,120}?onClick=\{handleNewSession\}/);
  assert.match(sidebar, /<WorktreePicker/);
  assert.match(picker, /openProjectEllipsis/);
  // The compact trigger opens the same dropdown, so session-less projects stay reachable.
  assert.match(picker, /compact \? \(/);
  assert.match(picker, /setDropdownOpen\(\(v\) => !v\)/);
});

test("a collapsed project group still expands when it holds the open session", () => {
  assert.match(sidebar, /collapsedProjectRoots\.has\(projectRoot\)/);
  assert.match(sidebar, /!sessions\.some\(\(s\) => s\.id === selectedSessionId\)/);
  assert.match(sidebar, /COLLAPSED_PROJECT_GROUPS_KEY/);
});

test("projects without sessions stay listed in aggregated mode", () => {
  // Session-backed groups plus the active and remembered session-less ones.
  assert.match(sidebar, /resolveEmptyProjectRoots\(/);
  assert.match(
    sidebar,
    /emptyProjectRoots\.map\(\(projectRoot\) => \(\{ projectRoot, sessions: \[\] as SessionInfo\[\] \}\)\)/,
  );
  assert.match(sidebar, /knownProjectRoots/);
  assert.match(sidebar, /loadKnownProjectRoots\(window\.localStorage\)/);
  assert.match(sidebar, /addKnownProjectRoot\(previous, selectedProject\)/);
  // Stale remembered projects are pruned through the desktop bridge.
  assert.match(sidebar, /pruneKnownProjectRoots\(/);
  assert.match(sidebar, /inspectLocalFiles/);
  // An empty group still invites the first session.
  assert.match(group, /projectNoSessions/);
});

test("project group headers carry the branch and a per-project worktree switcher", () => {
  assert.match(sidebar, /ensureProjectWorktrees\(root\)/);
  assert.match(sidebar, /getProjectWorktrees\(projectRoot\)/);
  assert.match(
    sidebar,
    /branch: activeWorktree\?\.branch \?\? mainWorktree\?\.branch \?\? latest\?\.worktreeBranch \?\? null/,
  );
  assert.match(sidebar, /worktreeInfo=\{group\.worktreeInfo\}/);
  assert.match(sidebar, /onSelectWorktree=\{\(path\) => setSelectedCwd\(path\)\}/);
  assert.match(group, /<ProjectBranchMenu/);
  assert.match(branchMenu, /<WorktreeDropdownPanel/);
  assert.match(branchMenu, /switchWorktree/);
  // Worktree create/remove stays shared with the independent-mode picker.
  assert.match(worktreePanel, /worktrees\.create/);
  assert.match(worktreePanel, /worktrees\.remove/);
  assert.match(worktreePanel, /newWorktree/);
});

test("the session list mode preference persists through the validated UI state patch", () => {
  assert.match(contract, /sessionListMode\?: SessionListMode/);
  assert.match(patchValidator, /isSessionListMode\(patch\.sessionListMode\)/);
  assert.match(store, /getUiState\(\)\)\.sessionListMode/);
  assert.match(store, /setUiState\(\{ sessionListMode: mode \}\)/);
});

test("the settings section exposes both modes with rollback feedback", () => {
  assert.match(settingsSection, /value="independent"/);
  assert.match(settingsSection, /value="aggregated"/);
  assert.match(settingsSection, /role="alert"/);
  assert.match(settingsSection, /sessionListModeSaveFailed/);
});
