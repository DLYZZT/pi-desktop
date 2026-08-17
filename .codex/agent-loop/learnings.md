# Learnings

## 2026-08-17

- **Trap:** Stop via `agent.command` waits on the same 120s RPC as prompts. Host reload / wedged port → `RPC call timed out: agent.command`. Abort handler never runs.
- **Do instead:** Renderer → Electron main → host `parentPort` `{type:session-abort}`. Never start a session to abort. Never await `agent.command`.
