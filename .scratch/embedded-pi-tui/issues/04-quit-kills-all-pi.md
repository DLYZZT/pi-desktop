# 04 — Quit Desktop kills every pi

**What to build:** Closing the Desktop window kills every spawned `pi` process tree. A later launch starts with no leftover terminals from last time.

**Blocked by:** 01 — Click session starts bundled pi

**Status:** ready-for-agent

- [ ] Closing Desktop terminates every tracked `pi` tree
- [ ] A new launch has an empty process map
- [ ] Lifecycle tests: quit → kill all
