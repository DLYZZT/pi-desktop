# 01 — Click session starts bundled pi

**What to build:** Selecting a session in the existing sidebar starts the Desktop-bundled `pi --session` in an external terminal for that session id and cwd. The in-process chat remains for this ticket. Selecting a session with no process means spawn, not a second in-process prompt.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Selecting a session with no live process starts bundled `pi --session` for that session, not PATH `pi`
- [x] The new process uses the session cwd
- [x] In-process chat still works; this ticket does not remove the composer
- [x] Lifecycle tests with a fake process port: select empty → spawn, and only spawn
