---
title: After a private merge, local main is not origin/main
date: 2026-08-18
category: workflow-issues
module: git-remotes
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "A PR merged to Doeye1997/pi-cockpit main via the private remote"
  - "Local main still tracks origin/main on pi-agent-desktop"
tags: [git, private-remote, checkout, worktree-label]
---

# After a private merge, local main is not origin/main

## Context

This checkout has three remotes. Cockpit PRs land on `private` (`Doeye1997/pi-cockpit`). Local `main` tracks `origin/main` (`Doeye1997/pi-agent-desktop`) and can sit many commits behind `private/main`.

`git checkout main` after merging PR #1 therefore opened the old origin-tracking tip. Feature files vanished from the index and reappeared as untracked/modified junk. The app looked broken. The worktree pill still showed `feat/subagent-tool-card-status` until the checkout actually sat on `main`.

## Guidance

After a merge on `private`:

1. `git fetch private`
2. Stash only real WIP.
3. `git checkout main`
4. Fast-forward to the merged tip: `git merge --ff-only private/main` or `git reset --hard private/main` when local `main` should match cockpit main.

Do not `git pull` (that talks to `origin`). Do not stop on a `main` whose tip is still the SuperGrok/composer-era origin commit.

The worktree control prints `currentWt.branch` from `src/renderer/components/SessionSidebar.tsx`. That string is the current git branch of this checkout, not the GitHub default branch.

## Why This Matters

Half-finished checkout leaves a dirty tree that looks like a product regression. Agents then "fix UI" on top of the wrong commit.

## When to Apply

- Just merged a `private` PR and the user says switch local to main.
- Worktree/cwd pill still shows the feature branch name after a remote merge.

## Examples

Wanted: local HEAD = `private/main` (Doeye1997/pi-cockpit PR #1, as of this writing).

Wrong: `git checkout main` then stop while `main...origin/main` is diverged and the working tree is a mix of old tracked files plus untracked cockpit sources.

## Related

- `docs/solutions/ui-bugs/tui-dock-bar-overflow-clips-menus.md` — dock click bugs; unrelated to this checkout trap.
