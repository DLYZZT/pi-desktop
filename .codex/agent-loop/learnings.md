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
- **Trap:** `wt -w <name>` without a subcommand opens a default PowerShell tab instead of focusing the existing Pi tab.
- **Do instead:** Use `wt -w <name> focus-tab --target 0`; keep each Pi session in its own named Terminal window.
