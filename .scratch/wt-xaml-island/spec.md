# Windows Terminal XAML island display

Status: ready-for-agent

## Problem Statement

Cockpit still shows Pi as an xterm.js bag: input jumps, scroll dies, cards clip menus, clicks hit glyphs. The user wants GPU cells they can keep optimizing, and a real GUI composer covering the TUI editor.

WezTerm as a native child HWND was tried and failed for this product. A scratch spike showed: HTML can sit on a WezTerm HWND for a simple shell; attaching WezTerm to the existing node-pty only paints scraps; WezTerm owning Pi inside the Electron hole breaks the TUI and eats typing; the same Pi in a standalone WezTerm window works. WezTerm has no embeddable control. Ghostty has no Windows GPU host that fits this Electron app.

Windows Terminal's TermControl is a real WinUI control with AtlasEngine (HLSL). Electron HTML cannot cover that HWND. The composer must be XAML in the same tree as the control.

## Solution

Keep the Electron cockpit window, the session list, and the file/tree chrome. Replace only the live session pane with a XAML Island: Windows Terminal TermControl draws Pi; a XAML composer card covers the TUI editor in that same island. One selected session is visible. Bundled `pi --tui-mode fullscreen` and existing session identity stay. No second Terminal window. No silent xterm fallback. No WezTerm.

## User Stories

1. As a cockpit user, I want the live Pi session drawn by Windows Terminal's GPU control, so that cells are not a DOM/xterm canvas bag.
2. As a cockpit user, I want that control hosted inside the existing cockpit window, so that I do not collect a second Terminal app window.
3. As a cockpit user, I want the same bundled `pi` and session files as today, so that conversations, keybindings, and jsonl do not fork.
4. As a cockpit user, I want selecting a session to show that session's Pi in the island, so that the tab and the picture stay one conversation.
5. As a cockpit user, I want switching sessions to show the other Pi in the same island, so that I do not collect extra terminal windows.
6. As a cockpit user, I want resize of the pane to change Pi rows/cols the way xterm fit does now, so that fullscreen layout still fills the pane.
7. As a cockpit user, I want scroll over the control to move Pi's fullscreen ScrollView, so that history is not stuck.
8. As a cockpit user, I want Chinese IME candidates on the XAML composer I actually type in, so that Windows Pinyin is usable.
9. As a cockpit user, I want the composer card to cover the TUI editor, so that I do not type into glyphs.
10. As a cockpit user, I want composer Enter to write a finished line plus CR to the same Pi connection, so that submit does not change.
11. As a cockpit user, I want `/` skill pick, model list, and thinking list to keep working, so that the display swap does not rip the dock.
12. As a cockpit user, I want worktree/cwd pills to stay clickable, so that menus are not eaten by the GPU surface.
13. As a cockpit user, I want Ctrl+click links if TermControl exposes them, so that I do not lose open-in-browser.
14. As a cockpit user, I want copy of a TermControl selection, so that I can paste logs out.
15. As a cockpit user, I want paste into the focused control or composer, so that clipboard still reaches Pi.
16. As a cockpit user, I want theme light/dark to retint the island, so that the pane matches the app.
17. As a cockpit user, I want a dead Pi to show a dead surface, so that a crash is not a frozen last frame pretending to live.
18. As a cockpit user, I want relocating cwd to remount the island on the new Pi, so that folder change still restarts the session.
19. As a cockpit user, I want closing the app to dispose the island and kill Pi processes, so that no GPU control is left behind.
20. As a cockpit user, I want no second external Windows Terminal app window for this cut, so that cockpit stays one desktop frame.
21. As a future agent, I want one session-display port (start, focus, write, resize, dispose, dead), so that the host can change later without touching session identity.
22. As a future agent, I want xterm.js gone from the live path, so that IME hacks against `.xterm-helper-textarea` die.
23. As a cockpit user, I want shader/display work confined to TermControl / AtlasEngine, so that HLSL iteration does not touch Electron chrome.
24. As a Windows user, I want this surface to run on the same Windows host the app already ships.
25. As a cockpit user, I want Pi `--tui-mode fullscreen` unchanged, so that the editor stays docked at the bottom of the TUI (and the XAML card covers it).
26. As a cockpit user, I want the GPU surface not cropped to hide chrome, so that clipping the live TUI is not a display trick.
27. As a cockpit user, I want wheel over the control to reach Pi, so that I can scroll without focusing a hidden xterm.
28. As a cockpit user, I want font size comparable to today's 14px mono, so that density does not jump.
29. As a cockpit user, I want 256-color / truecolor Pi output, so that theme colors survive.
30. As a cockpit user, I want TermControl to ignore a user Windows Terminal settings file that would steal keys from Pi, so that the app's session owns input while the control is focused.
31. As a developer, I want a fake session-display in tests, so that spawn/resize/write can stay node:test.
32. As a developer, I want a failure to create the island or TermControl to be loud, so that we do not silently fall back to xterm and hide the point of the cut.
33. As a cockpit user, I want one live picture per selected session, so that background sessions do not each open a Terminal window.
34. As a cockpit user, I want background session output still kept, so that switching back is not a blank GPU buffer.
35. As a cockpit user, I want the XAML composer z-order above TermControl, so that pills stay hittable.
36. As a cockpit user, I want the project tree and file chrome to stay Electron HTML, so that this cut does not rewrite the whole shell.
37. As a cockpit user, I want the composer layout to stay the two-capsule card (input full width on top, cwd/worktree/usage/model/thinking/MCP under it), so that the 2026-08-18 input-chrome decisions survive the host change.
38. As a cockpit user, I want cwd and worktree on that card to still open the existing folder/worktree pickers, so that I do not get a second relocate path.
39. As a cockpit user, I want dock facts (path, usage, model, thinking, statuses) to come from session/app state, so that we do not parse live cells from an xterm buffer that no longer exists.
40. As a cockpit user, I want focusing the composer to take typing away from TermControl, so that keys do not double-enter the TUI editor.
41. As a cockpit user, I want focusing TermControl (click on cells) to let me select/copy logs, so that the surface is not dead glass.
42. As a future agent, I want Electron-wide WinUI rewrite out of this spec, so that a full host swap does not block the island.
43. As a future agent, I want WezTerm, Ghostty, and a from-scratch wgpu renderer out of this spec, so that this cut stays on TermControl.
44. As a cockpit user, I want a missing WebView2 / WinAppSDK / TermControl runtime to show a hard error in the pane, so that I know what to install.
45. As a cockpit user, I want DPI and window move to keep the island aligned with the Electron pane hole, so that the control does not drift.
46. As a cockpit user, I want minimizing and restoring the app to keep the island alive, so that I do not get a black hole after taskbar restore.
47. As a cockpit user, I want multiple displays / DPI change to remount or rescale the island, so that cells stay readable.
48. As a developer, I want experimental WT pixel shaders optional and off by default, so that HLSL play does not block the first cut.
49. As a cockpit user, I want Stop / dead marks in the sidebar to still match the island process, so that I can kill a stuck Pi.
50. As a future agent, I want the old WezTerm GPU-child spec treated as void, so that nobody implements SetParent wezterm-gui.

## Implementation Decisions

- One seam: the existing session-TUI policy (start / focus / write / resize / kill / dead marks). Do not add a second policy module. The implementation behind that seam becomes a XAML Island + TermControl, not node-pty bytes into xterm.js.
- TermControl owns the Pi connection (it starts bundled `pi` with `--tui-mode fullscreen` and the existing `--session` / `--session-id`). Do not byte-bridge an Electron node-pty into TermControl. Scratch proved attach-to-existing-PTY is not a product path.
- Live display is a XAML Island parented into the cockpit terminal pane. Composer, pills, and menus that must sit on the picture are XAML in that island. Electron HTML does not cover the island HWND.
- Tree, files, and the rest of the shell stay Electron HTML beside the island.
- No silent xterm fallback. If the island or TermControl cannot start, the pane shows a hard error and Pi is not left half-attached.
- Do not clip the PTY to hide TUI chrome. Cover the editor band with the XAML card. Do not grow the viewport off-screen.
- IME: type in the XAML composer. Enter sends the finished line plus CR through the session-TUI write path into the TermControl connection. No per-keystroke forwarding. No xterm helper textarea.
- Wheel and selection belong to TermControl when the pointer is on cells; composer widgets keep their own pointer events.
- One visible TermControl for the selected session. Background sessions stay alive without extra OS windows so switching back is not blank. Hide unused controls; do not spawn `wt.exe` windows.
- Relocate cwd kills and remounts the TermControl on the new placement, same as today's PTY restart.
- App quit disposes the island and kills Pi.
- TERM stays a 256-color capable value TermControl documents; do not invent a second session type.
- Dock chrome shown on the card comes from session/app state, not from scanning terminal cells.
- Tests fake the session-display. They do not launch Windows Terminal, WinUI, or Electron.
- Later full WinUI shell may reuse this island. It is not this spec.
- Prototype note (from `.scratch/wezterm-display`): SetParent + WS_CHILD on wezterm-gui painted a simple cmd and accepted an HTML overlay; Pi inside that hole did not paint or take keys; standalone WezTerm ran Pi. That is why this spec uses a real control + XAML, not a foreign GPU HWND.

## Testing Decisions

- Good tests only check external behavior of the session-display port: attach, write, resize, detach, error-if-missing-island, relocate remount, dead marks. They do not assert HLSL source, GPU vendor, pixel buffers, or XAML visual trees.
- One seam: the existing session-TUI tests (`node:test`, fake process). Do not add a second policy module.
- Do not add a Windows Terminal e2e or screenshot suite in this cut.
- Prior art: session-TUI contract tests and EmbeddedPiTerminal tests (replace the xterm-specific cases; keep the session policy cases).

## Out of Scope

- WezTerm / SetParent / mux / byte-bridge.
- Ghostty / libghostty.
- A from-scratch wgpu/GLSL/WebGPU cell renderer.
- Rewriting the whole cockpit in WinUI.
- Going back to an external `wt.exe` or WezTerm OS window as the live path.
- Changing Pi session files, archive, relocate rules, or channel inbound.
- Per-keystroke forwarding into the TUI editor.
- Cropping the PTY to hide dock rows.
- HTML overlay on a native HWND.
- Silent xterm fallback.

## Further Notes

Supersedes `.scratch/wezterm-display/spec.md` and GitHub issue “spec: WezTerm GPU display surface”. That cut is void.

TUI input-chrome decisions (card covers the editor, Fluent-looking composer, no per-keystroke, cwd/worktree as controls) stay. The stack under the card changes from Electron HTML over xterm to XAML over TermControl. Electron Fluent React remains for chrome outside the island.

Seam check: one session-TUI port; TermControl owns Pi. If that is the wrong cut, say so before implementation.
