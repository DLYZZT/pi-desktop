# 03 — Rebase onto latest upstream

**What to build:** Replay the overlay onto current DLYZZT main. Daily Desktop then has official fixes plus the fork extras. Any leftover conflict should sit on the hook lines, not inside overlay behavior.

**Blocked by:** 01 — Usage overlay; 02 — Session list overlay

**Status:** done

- [x] Branch is rebased onto current `upstream/main`
- [x] Usage chips and multiline notices still work
- [x] All-projects list and archive still work
- [x] Overlay files carry the extras; upstream files only have hooks
