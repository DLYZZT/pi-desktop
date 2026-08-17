# Session hang — 2026-08-17

Decisions from the hang grill. Not a spec.

## Decision: what to do first

- **Chosen:** Fix Pi hang. Do not resume the tiktok NAS cron in a new chat.
- **Why:** Same hang class was killing sessions all day.
- **Rejected:** Continue the aborted NAS cron work in this session.

## Decision: first hang slice

- **Chosen:** Independent Stop/abort channel.
- **Why:** Stop was already rewritten many times. Failure was delivery (`agent.command` RPC timeout), not the abort handler.
- **Rejected:** Default bash wall-clock timeout as the first slice. Auto-timeout stays next. Sidebar TDZ and ping-kill stay later.

## Decision: how to measure a hung bash (research, not shipped)

- **Chosen:** Wall-clock. Model-omitted timeout should get a default later.
- **Why:** Pi bash already uses optional wall-clock. Claude Code Bash is wall-clock (2 min default, ~10 min cap). `timeout` / `curl --max-time` are wall-clock. Idle-silence is for MCP/network, and would kill quiet NAS/SSH.
- **Rejected:** Kill on N seconds of no stdout. Dual wall-clock + idle watchdog.

## Decision: abort transport

- **Chosen:** Renderer `piBridge.abortSession` → Electron main → host `parentPort` `{type:session-abort}`. Abort live sessions only. Never `startRpcSession` to abort. Never await `agent.command`.
- **Why:** `Failed to abort: RPC call timed out: agent.command` meant Stop never reached the handler. Parent port is the ping path; it does not share the 120s renderer RPC.
- **Rejected:** Another `agent.command` abort rewrite. New `agent.abort` RPC on the same MessagePort. Auto-background-on-timeout (Claude Code). Kill host from main when abort is not acked.

## Decision: in-flight abort cut (after transport)

- **Chosen:** A — cut the live stream/process and keep Stop until `agent_end`.
- **Why:** 2026-08-17 log: `session-abort … delivered` three times in two minutes. Delivery worked; Grok/bash did not stop. Optimistic idle hid Stop.
- **Rejected:** B — kill the host process tree from main if abort stays running. Still open for event-loop wedge.

## Decision: Stop is Ctrl+C from main

- **Chosen:** On Stop, main `taskkill /T /F` tracked bash pids and host `ssh`/`bash` descendants. Host `session-abort` still posted.
- **Why:** Log: `session-abort delivered` many times while SSH stayed up. Host handler is not a console Ctrl+C. Git-bash can hide `ssh.exe` from the wrapper tree.
- **Rejected:** Waiting for host abort to become a real SIGINT. Killing the whole host process on first Stop.

## Still open

- Default wall-clock duration (2 / 5 / 10 min).
- On timeout: kill and return error to the model / background the process / stop the whole turn.
- Host event-loop wedge: parentPort also cannot run; process-tree kill from main is not decided.
