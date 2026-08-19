---
title: Idle Pi TUI has a blank row at the window bottom
date: 2026-08-18
category: ui-bugs
module: EmbeddedPiTerminal
problem_type: ui_bug
component: assistant
symptoms:
  - "Idle TUI shows a blank row under MCP, aligned with the sidebar Settings button"
  - "Working or Thinking removes that blank row and the dock sits flush to the bottom"
  - "Treating the blank as a gap above the editor covers Working or eats a transcript row"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [tui-dock, idle-blank, working, clip]
---

# Idle Pi TUI has a blank row at the window bottom

## Problem

Pi's interactive TUI, when idle, draws one extra empty row under the footer (path / usage / MCP). That row sits at the window bottom next to Desktop's Settings control. When a turn is live, `Working` or `Thinking` appears above the editor and the blank row at the bottom is gone.

## Symptoms

- Side-by-side: idle footer has empty space under MCP, flush with Settings; running footer has no that space.
- Covering "one extra row" from the top hides `Working`.
- A single fixed cover height cannot match both idle and running.

## What Didn't Work

- Scanning box-drawing characters every render to size a clip. Height chased the buffer and the PTY resized in a loop (flash).
- Assuming the extra row was above the editor (where `Working` appears). That inverted idle vs running and kept covering the wrong band.
- Clipping the dock and also overlaying the same number of rows. Visible TUI lost twice the dock height.
- Putting the HTML composer in document flow so it reserved its own height on top of the clip (TUI got pushed up).

## Solution

Keep two independent measurements:

- **Cover band** — the six-row dock (borders, input, path, usage, MCP). The HTML composer overlays that band only. See `DOCK_COVER_ROWS` in `src/renderer/components/EmbeddedPiTerminal.tsx`.
- **Idle blank** — one extra row clipped off the xterm host when no live status line is present (`IDLE_BLANK_ROWS`). When `Working` / `Thinking` / `Compacting` is on screen, that clip is zero so the dock stays flush and `Working` stays visible.

`idleBlankPx` uses `tuiIsRunning` (live-status scan) only to pick 0 vs one row. It does not re-measure the whole dock. The composer height stays the six-row cover, not seven.

## Why This Works

The idle blank and `Working` are not the same screen slot. `Working` is above the editor. The idle blank is below MCP. Treating them as one slot guaranteed the wrong row would be hidden. Separating "cover the dock" from "eat the idle bottom pad" matches the side-by-side TUI.

## Prevention

- When a TUI layout bug is "one row off," ask whether the extra row is above the editor or under the footer. Confirm against an idle screenshot next to Settings, not against `Working`.
- Do not clip and overlay the same band.
- Do not change PTY size from per-frame buffer scans.

## Related Issues

- `docs/decisions/2026-08-18-tui-input-chrome.md` — composer cover decisions
