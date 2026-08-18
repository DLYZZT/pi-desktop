# Learnings

## 2026-08-17

- **Trap:** Stop via `agent.command` waits on the same 120s RPC as prompts. Host reload / wedged port → `RPC call timed out: agent.command`. Abort handler never runs.
- **Do instead:** Renderer → Electron main → host `parentPort` `{type:session-abort}`. Never start a session to abort. Never await `agent.command`.
- **Trap:** `session-abort delivered` only means `send({type:abort})` ran. Grok SSE keeps reading unless the fetch body is cancelled; Windows soft `taskkill` lets Git-bash exit and leaves SSH/curl alive; optimistic `setAgentRunning(false)` hides Stop while the turn continues.
- **Do instead:** Cancel the fetch body on abort. Windows `taskkill /T /F` immediately. Keep Stop until `agent_end`.
- **Trap:** Desktop `waitForClose` only listens to Node `'close'`. Git-bash `ssh` inherits stdout/stderr; `'close'` never fires → every SSH hangs the turn.
- **Do instead:** Wait on `exit` + 100ms stdio idle (Pi #5303). Do not wait for inherited pipes to close.
- **Trap:** `session-abort delivered` can still leave Windows `ssh.exe` alive. Git-bash MSYS child is not always in the bash `taskkill /T` tree. Host abort is not Ctrl+C.
- **Do instead:** Main kills tracked bash pids and host command descendants (`ssh`/`bash`) on Stop. Do not wait for the host handler.
- **Trap:** `wmic ... /FORMAT:CSV` returns `Invalid XSL format` on this machine. Interrupt logged `bash=none` and killed nothing. Stop looked dead.
- **Do instead:** Parse default WMIC table. Kill only `bash`/`ssh`/`curl` under the host. Never `taskkill` `fastctx.exe` or `node.exe` — those are MCP workers, not the hung SSH.
- **Trap:** External Windows Terminal ownership/focus couples the cockpit to `wt.exe`, PowerShell P/Invoke, window titles, and OS z-order timing. A focus attempt can open the wrong shell or leave Pi behind the side windows.
- **Do instead:** Keep one Electron window. Run one `node-pty` ConPTY per Pi session and render persistent xterm.js instances in the center pane; sidebar switching only changes the visible terminal.
- **Trap:** xterm.js 6.0 can leave its hidden IME textarea at a stale cursor position when an AI CLI draws placeholder text and restores the cursor. First Chinese candidate window then appears at the placeholder's right edge.
- **Do instead:** Until the upstream xterm.js 7 fix ships, keep the helper textarea and `.composition-view` on the visible Pi editor caret. Pin in capture-phase `keydown` (keyCode 229) and `compositionstart` — Windows IME samples the caret then; later style writes do not move the already-shown candidate window.
- **Trap:** Windows ConPTY often leaves xterm `cursorX` at the end of the footer (model name) and may flatten `─` borders to `-`. Trusting hardware `cursorX` near `cols-1` still pins IME to that footer-right cell.
- **Do instead:** Treat `-`/`─` as editor borders. Ignore hardware X in the right half of the row; fall back to the typical input row (`rows-3`, x=0). Keep the helper textarea at opacity 0.01 / z-index 10 and re-pin on style mutations — xterm writes `z-index:-5` and the Windows IME samples that element.
- **Trap:** Re-scanning the editor caret and resetting textarea width on every `compositionupdate`/`onRender` makes the Windows candidate window bounce while typing one character at a time.
- **Do instead:** Lock the cell at `compositionstart`. While composing, only restore `left`/`top` if xterm moved them; do not resize.
- **Trap:** Session navigation replaced the URL query without retaining `#cockpit`. UI stayed correct until reload/HMR, then booted the legacy full shell.
- **Do instead:** Router-compatible query/path replacement must preserve the current cockpit role hash unless the destination explicitly supplies another hash; treat an empty legacy URL as the default cockpit so stale state self-recovers.
- **Trap:** A raw xterm + PTY bridge provides terminal input/output but not desktop copy semantics or web-link detection. `Ctrl+C` always reaches the PTY and rendered URLs are inert.
- **Do instead:** Intercept `Ctrl/Cmd+C` only when xterm has a selection; otherwise preserve PTY interrupt behavior. Load xterm's official web-links addon and open Ctrl-clicked URLs through the existing allowlisted Electron bridge.
- **Trap:** Pi `--session <id>` only looks up an existing path or partial UUID. Passing a fresh sidebar UUID makes folder-scoped session creation fail even though PTY `cwd` is correct.
- **Do instead:** Resume known session files with `--session <path>`; create sidebar sessions with `--session-id <exact-id>`.
- **Trap:** Resolving the bundled Pi CLI with `intent: project-command` applies `package.json` engines. A folder that wants Node 22 plus a machine on Node 24 throws `Node.js is required to open Pi CLI` even though Node exists.
- **Do instead:** Spawn the bundled CLI with toolchain default `js.node`, not the project-resolved Node.
