# WezTerm HWND overlay spike

THROW AWAY. Answers one question, then delete or absorb.

## Question

Can Electron HTML (button + input) sit on a WezTerm GPU HWND child in the same window — visible and clickable — so a Fluent composer can cover TUI cells?

## Run

```
node .scratch/wezterm-display/run.mjs
```

Stable WezTerm: `C:\Program Files\WezTerm\wezterm-gui.exe`

## Judge

- PASS paint: red bar visibly covers terminal cells
- PASS input: CLICK OVERLAY increments; input takes focus / IME
- FAIL: red bar missing, clipped, or clicks fall into WezTerm

Top yellow strip is outside the HWND hole so the window stays usable.

## Verdict

2026-08-18 user: 是是是 → paint / click / type all yes.

HTML overlay can sit on a WezTerm HWND child in this Electron 43 + WezTerm 20240203 scratch window.
Airspace is not the blocker on this host.

Still unproven: attach WezTerm to the existing Pi node-pty (spike used WezTerm's own cmd.exe).

## PTY question

Can WezTerm show the **existing** Electron `node-pty` (bundled Pi), not its own shell?

WezTerm CLI has no attach-to-existing-PTY / ConPTY handle. Official: `start` / `serial` / mux / ssh.
This spike is a **byte bridge**: node-pty (Pi) ↔ TCP ↔ `relay.cjs` inside WezTerm's own PTY. Double PTY. Not true attach.

```
node .scratch/wezterm-display/run-pty.mjs
```

Judge: black area is Pi (or `NODEPTY-SPIKE`), typing in the black area reaches that PTY, red overlay still clicks.

## PTY verdict

2026-08-18 log: WezTerm has no attach-to-existing-PTY API.
Byte bridge works at the pipe: Pi TUI bytes (`Warning: No project session`, skill names, box drawing) reached the relay after HWND SetParent.
User 2026-08-18: yellow warning text visible; full Pi TUI not visible; typing in the hole has no effect; red overlay still clicks.

Byte bridge is not a product path: double ConPTY shows scraps of Pi output, not a live session.

## Own-Pi question

Can WezTerm spawn bundled Pi itself (no node-pty, no relay) and still sit in the Electron hole with overlay?

```
node .scratch/wezterm-display/run-own.mjs
```

## Own-Pi verdict

2026-08-18 user: not a complete Pi; typing in the hole has no effect.
HWND parent succeeded; no wezterm exit in log. Embed + WezTerm-owned Pi is not a usable session.

## Solo question

Does a normal WezTerm window (no Electron, no SetParent) run bundled Pi?

```
node .scratch/wezterm-display/run-solo.mjs
```

## Solo verdict

2026-08-18 user: complete Pi, typing works.
WezTerm can host Pi. SetParent embed is what breaks the session.

## Embed research (2026-08-18)

- Official GUI is a standalone app. No HWND-child / Electron widget API.
- [wezterm#6020](https://github.com/wezterm/wezterm/issues/6020) (open since 2024): embed like VTE/VS Code. No wez design. Commenters suggest xterm.js+tauri.
- Docs (wezterm.org): mux/ssh/serial/cli only. No embed chapter.
- `wezterm-term` / termwiz = emulator crates, not a GPU widget. Using them = own renderer (out of this spec).
- SetParent+WS_CHILD is unofficial. Our spike: cmd+overlay works; Pi paint/input dies.

## Alt engines (embed + HLSL/GLSL)

- Native HWND + shaders (WT AtlasEngine/HLSL, Ghostty/GL, Alacritty) still fight HTML overlay; WT is a real control, WezTerm is not.
- In-Chromium WebGL/WebGPU (xterm addon-webgl, or own cell renderer) is the only path that keeps composer-on-cells and lets us ship GLSL/WGSL.

## Perf (Pi TUI, not cat-linux)

Pi redraw is small. Hop/input/resize matter more than shader fill-rate.

- now: node-pty → IPC → xterm JS parse → canvas. Fine until overlay/IME/scroll.
- WT TermControl: native VT + AtlasEngine HLSL; can own ConPTY (no JS hop). WT 1.22 ConPTY host: ~2× VT-heavy I/O, up to 16× plaintext vs old host. User HLSL via experimental pixel shaders.
- WezTerm standalone: same class as other GPU terms; embed path dead here.
  Do not promise a 10× Pi feel. Promise: fewer hops, better IME, real HLSL.

## Product fork (2026-08-18)

User: 2 then B — Windows Terminal TermControl + XAML overlay (leave Electron HTML covering cells).
WezTerm-in-Electron spec is the wrong vehicle. New host/display spec needed.
Open: island-in-Electron vs full WinUI window.

Chosen: XAML Island in the existing Electron window — TermControl + XAML composer only. Sidebar/files stay HTML.
WezTerm GPU-child spec superseded for this product.
