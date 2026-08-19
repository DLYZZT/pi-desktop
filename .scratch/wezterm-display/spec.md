# WezTerm GPU display surface

Status: superseded

Void. Replaced by `.scratch/wt-xaml-island/spec.md` (Windows Terminal XAML island). Do not implement this cut.

## Problem Statement

Cockpit shows Pi by wrapping a PTY in xterm.js and then covering the dock with HTML. That wrapper keeps breaking: input jumps, scroll dies, cards clip menus, clicks hit glyphs. The user does not want a better bag around xterm. They want the terminal _display_ itself to be the product — GPU-drawn cells, something they can keep optimizing — on Windows.

## Solution

Keep the existing session PTY and bundled `pi` process. Replace only the cell renderer. WezTerm’s GPU surface draws the live TUI. GLSL/OpenGL/WebGPU lives in that surface. Electron chrome (tree, files, composer) can stay for this cut. Ghostty and a full Electron rewrite wait.

## User Stories

1. As a cockpit user, I want the live Pi session drawn by a GPU terminal, so that cells are not a DOM/xterm canvas bag.
2. As a cockpit user, I want that display to be WezTerm, so that Windows already has a mature GPU path.
3. As a cockpit user, I want the same bundled `pi` PTY as today, so that sessions, keybindings, and jsonl do not fork.
4. As a cockpit user, I want selecting a session to attach WezTerm to that session’s PTY, so that the tab and the picture stay one conversation.
5. As a cockpit user, I want switching sessions to show the other PTY in the same surface, so that I do not collect extra terminal windows.
6. As a cockpit user, I want resize to change PTY rows/cols the way xterm fit does now, so that Pi fullscreen layout still fills the pane.
7. As a cockpit user, I want scroll to move Pi’s fullscreen ScrollView, so that history is not stuck.
8. As a cockpit user, I want Chinese IME candidates on the input I actually type in, so that Windows Pinyin is usable.
9. As a cockpit user, I want the Fluent composer to keep covering the TUI editor if it still exists, so that I do not type into glyphs.
10. As a cockpit user, I want composer Enter to write a finished line plus CR to the same PTY, so that submit does not change.
11. As a cockpit user, I want `/` skill pick, model list, and thinking list to keep working, so that display swap does not rip the dock.
12. As a cockpit user, I want worktree/cwd pills to stay clickable, so that menus are not eaten by the new surface.
13. As a cockpit user, I want Ctrl+click links if WezTerm exposes them, so that I do not lose open-in-browser.
14. As a cockpit user, I want copy of a WezTerm selection, so that I can paste logs out.
15. As a cockpit user, I want paste into the focused surface or composer, so that clipboard still reaches Pi.
16. As a cockpit user, I want theme light/dark to retint the surface, so that the pane matches the app.
17. As a cockpit user, I want a dead PTY to show a dead surface, so that a crash is not a frozen last frame pretending to live.
18. As a cockpit user, I want relocating cwd to remount the surface on the new PTY, so that folder change still restarts Pi.
19. As a cockpit user, I want closing the app to dispose the surface and kill PTYs, so that no GPU window is left behind.
20. As a cockpit user, I want no second external WezTerm app window for this cut, so that cockpit stays one desktop frame.
21. As a future agent, I want one TerminalSurface port (bytes, size, focus, dispose), so that WezTerm can be swapped later without touching session policy.
22. As a future agent, I want xterm.js gone from the live path, so that IME hacks against `.xterm-helper-textarea` die.
23. As a future agent, I want shader/display work confined to the WezTerm surface, so that GLSL/GPU iteration does not touch Electron chrome.
24. As a Windows user, I want this surface to run on the same Windows host the app already ships, so that Ghostty’s weak embed is not the blocker.
25. As a cockpit user, I want Pi `--tui-mode fullscreen` unchanged, so that the editor stays docked at the bottom of the TUI.
26. As a cockpit user, I want the GPU surface not to crop the PTY to hide chrome, so that clipping the live TUI is not a display trick.
27. As a cockpit user, I want wheel over the surface to reach Pi, so that I can scroll without focusing a hidden xterm.
28. As a cockpit user, I want font size comparable to today’s 14px mono, so that density does not jump.
29. As a cockpit user, I want 256-color / truecolor Pi output, so that theme colors survive.
30. As a cockpit user, I want the surface to ignore PATH WezTerm config that would steal keys from Pi, so that the app’s PTY owns input while focused.
31. As a developer, I want a fake TerminalSurface in tests, so that session spawn/resize/write can stay node:test.
32. As a developer, I want a failure to create the GPU surface to be loud, so that we do not silently fall back to xterm and hide the point of the cut.
33. As a cockpit user, I want one live surface per selected session, so that background sessions do not each open a WezTerm window.
34. As a cockpit user, I want background PTY output still recorded, so that switching back is not a blank GPU buffer.
35. As a cockpit user, I want the composer overlay z-order above the GPU surface, so that pills stay hittable.
36. As a future agent, I want Electron replacement out of this spec, so that host rewrite does not block display work.
37. As a future agent, I want custom wgpu/GLSL renderer out of this spec, so that WezTerm can prove GPU cells first.
38. As a cockpit user, I want Windows Terminal / HLSL out of this spec, so that the engine stays the one chosen for GPU-on-Windows-plus-shader-family.

## Implementation Decisions

- One seam: TerminalSurface. Session PTY manager stays. It writes bytes, resizes, and dies the same way. Only the consumer of those bytes changes.
- Live display is a WezTerm GPU surface parented into the cockpit pane (native child surface), not `@xterm/xterm` and not an external WezTerm OS window for the happy path.
- Spawn still uses bundled `pi` with `--tui-mode fullscreen` plus existing `--session` / `--session-id`.
- TERM stays a 256-color capable value the PTY already uses unless WezTerm requires a documented alias; do not invent a second session type.
- No silent xterm fallback. If the surface cannot start, the pane shows a hard error and the PTY is not left half-attached.
- Composer, worktree portal, and dock chrome remain Electron HTML for this cut. They stack above the surface. Overflow on the dock bar stays visible so menus work.
- Do not clip the PTY host to hide TUI chrome. Cover with HTML if the composer stays; do not grow the PTY viewport off-screen.
- IME: keep typing in the Fluent composer for this cut. Do not re-pin an xterm helper textarea. WezTerm IME is only required if the composer is hidden.
- Wheel and selection belong to the surface when the pointer is on it; composer widgets keep their own pointer events.
- Tests fake TerminalSurface. They do not launch WezTerm or Electron.
- Later host rewrite (leave Electron) and later owned wgpu renderer are allowed to reuse this same port. They are not this spec.

## Testing Decisions

- Good tests only check external behavior of the session↔surface port: attach, write, resize, detach, error-if-missing-surface, relocate remount. They do not assert shader source, GPU vendor, or pixel buffers.
- One seam: TerminalSurface. Reuse `src/main/fork/session-tui.test.mjs` style (`node:test`, fake PTY). Do not add a second policy module.
- Do not add a WezTerm e2e or screenshot suite in this cut.
- Prior art: EmbeddedPiTerminal and session-pty contract tests.

## Out of Scope

- Replacing Electron or rewriting the cockpit chrome.
- Ghostty / libghostty.
- A from-scratch wgpu/GLSL cell renderer.
- Windows Terminal AtlasEngine / HLSL.
- Going back to an external OS terminal as the live path.
- Changing Pi session files, archive, relocate rules, or channel inbound.
- Per-keystroke forwarding into the TUI editor.
- Cropping the PTY to hide dock rows.

## Further Notes

Older scratch spec (`.scratch/embedded-pi-tui/spec.md`) forbade embed and wanted an external Windows Terminal. That is superseded for display: embed a GPU surface, keep the in-app PTY.

TUI input-chrome decisions (Fluent composer, no per-keystroke) stay unless a later spec drops the card.

Seam check: one TerminalSurface port plus the existing PTY manager. If that is the wrong cut, say so before implementation.
