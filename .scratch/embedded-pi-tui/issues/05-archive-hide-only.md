# 05 — Archive is hide-only; open still spawn/focus

**What to build:** Archive only hides a row from the default list. Opening an archived session uses the same start-or-focus `pi --session` path as any other tab. Unarchive puts the row back and does not spawn.

**Blocked by:** 02 — Reselect focuses, switch keeps the other pi

**Status:** ready-for-agent

- [x] Archive / unarchive change list membership only; they do not kill or spawn
- [x] Selecting an archived session starts or focuses `pi --session` with the same rules as an unarchived tab
- [x] Unarchive does not open a terminal until the user selects the row
- [x] Lifecycle tests: archive does not spawn/kill; select archived → spawn or focus
