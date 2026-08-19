---
title: Dock bar overflow clips upward menus so pills look dead
date: 2026-08-18
category: ui-bugs
module: TuiDockComposer
problem_type: ui_bug
component: assistant
symptoms:
  - "Cwd, worktree, model, and thinking pills do not appear to respond"
  - "Clicking a pill produces no visible menu"
  - "TUI box-drawing under the card can be mistaken for the real controls"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [tui-dock, overflow, menus, pointer-events]
---

# Dock bar overflow clips upward menus so pills look dead

## Problem

HTML pills on the cockpit composer bar open menus upward. With `overflow-x: auto` on that bar, those menus are clipped to the bar box. Clicks fire, but nothing visible appears, so the controls look dead.

## Symptoms

- Model / thinking / cwd / worktree clicks do nothing on screen.
- The TUI editor rule under a short overlay can look like the real bar; clicks on those glyphs go to xterm.

## What Didn't Work

- Treating empty input as the cause. An empty Fluent field still has height; that was a different crush, not the dead clicks.
- Cropping the PTY (`height: calc(100% + Npx)`) to hide TUI chrome. User rejected clipping. It also did not make menus visible.
- Blaming xterm's helper textarea alone. `pointer-events: none` on that node is useful, but clipped menus stay invisible.

## Solution

Keep the bar in flow and let menus paint outside it. Current rule in `src/renderer/globals.css`:

```css
.tui-dock-bar {
  overflow: visible;
}
```

Menus stay `position: absolute; bottom: calc(100% + 4px)` on `.tui-dock-pick-menu`. Do not put `overflow-x: auto` on an ancestor that also hosts those menus.

If the bar is too wide, shrink labels (`min-width: 0`, ellipsis). Do not scroll-clip the bar.

The overlay card sits on top of the TUI (`z-index: 20`). The PTY stays full-pane (`applySessionLayout` inset 0, height 100%). No extra clip.

## Why This Works

`overflow-x: auto` makes a scrollport. Absolutely positioned children that escape upward are clipped (and in some engines `overflow-x: auto` also forces a non-visible `overflow-y`). The click handler still runs; the menu has zero visible area.

## Prevention

- If a row owns upward popovers, keep `overflow: visible` on that row.
- Need horizontal scroll? Put it on an inner track that does not wrap the popovers, or portal the menu.

## Related Issues

- `docs/solutions/ui-bugs/idle-tui-bottom-blank-row.md` — idle TUI extra row vs cover height; different bug, same dock.
