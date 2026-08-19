# 02 — Session list overlay

**What to build:** The all-projects session list and manual archive/unarchive live in the overlay layer. The upstream sidebar only keeps thin hooks. New sessions still land in the last selected project. Archiving hides one row, keeps the file, and does not pull children with it.

**Blocked by:** 01 — Usage overlay

**Status:** done

- [x] Default sidebar shows sessions from every project, with a project tag
- [x] Project picker filters the list instead of hiding other repos
- [x] A session can be archived and later unarchived from the Archived drawer
- [x] Overlay owns the extra behavior; upstream files only call hooks
