# 07 — Folder + new session starts pi; right window follows cwd

**What to build:** A folder `+` creates an unarchived session and starts bundled `pi` in that folder's cwd. The right cockpit window (files and user-driven browser) follows the selected tab's cwd.

**Blocked by:** 06 — Two floating cockpit windows; middle is not the live path

**Status:** ready-for-agent

- [x] Folder `+` creates a session in that folder's cwd and starts `pi --session`
- [x] The right window's files (and browser cwd context) match the selected session
- [x] Switching tabs updates the right window to the new session cwd
