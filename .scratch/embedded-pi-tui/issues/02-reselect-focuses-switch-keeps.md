# 02 — Reselect focuses, switch keeps the other pi

**What to build:** A session that already has a live `pi` does not open a second terminal. Selecting it focuses the existing window. Switching to another session leaves the previous `pi` running.

**Blocked by:** 01 — Click session starts bundled pi

**Status:** ready-for-agent

- [x] Selecting a live session focuses its terminal and does not spawn another process
- [x] Selecting the already-selected live tab only focuses
- [x] After switching away, the previous session's process is still live
- [x] Lifecycle tests: live select → focus; switch → keep
