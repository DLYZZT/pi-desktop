# 03 — Tree marks + kill / exit / reselect

**What to build:** The session tree shows a one-line true status from the process map (running, dead, none). A tree kill or TUI `/exit` marks that session dead and does not auto-respawn while it stays selected. Selecting it again starts a new `pi`.

**Blocked by:** 02 — Reselect focuses, switch keeps the other pi

**Status:** ready-for-agent

- [ ] A live session shows running (waiting-for-input optional); no process shows no live mark; an exited process shows dead
- [ ] Tree status comes from the process map, not in-process `agent.state`
- [ ] Tree kill or child exit stops that `pi` and leaves the selected session dead without auto-spawn
- [ ] A later select of a dead session spawns again
- [ ] Lifecycle tests: kill/exit → dead + no flap; later select → spawn
