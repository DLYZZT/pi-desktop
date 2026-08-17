# 04 — Quit Desktop kills every pi

**What to build:** Closing the Desktop window kills every spawned `pi` process tree. A later launch starts with no leftover terminals from last time.

**Blocked by:** 01 — Click session starts bundled pi

**Status:** ready-for-agent

- [x] Closing Desktop terminates every tracked `pi` tree
- [x] A new launch has an empty process map
- [x] Lifecycle tests: quit → kill all
