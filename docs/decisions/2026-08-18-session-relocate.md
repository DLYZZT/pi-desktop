# Session relocate — 2026-08-18

Decisions from the cwd/workspace grill. Not a spec.

## Decision: what happens to the open chat

- **Chosen:** In-place relocate. Same session continues. Tools run in the new folder. Session file moves with the header `cwd`.
- **Why:** The pain was “this chat is in the wrong repo,” not “I want a copy.”
- **Rejected:** Fork a history copy into the new repo. Close and open an empty session (already exists).

## Decision: where to trigger it

- **Chosen:** Dedicated control on the open chat (session-info working directory row → Change).
- **Why:** Sidebar project picker is a filter + new-session cwd. Reusing it would relocate when the user only wanted to look at another project.
- **Rejected:** Reuse the sidebar project dropdown. Both entry points.

## Decision: while the agent is running

- **Chosen:** Idle only. Disable / tell the user to Stop first.
- **Why:** Avoid mid-flight tools writing into the old repo. Stop is already the abort path; relocate should not couple to it.
- **Rejected:** Abort-then-move on click. Move under a live turn.

## Decision: how to pick the destination

- **Chosen:** Recent project list + Browse folder.
- **Why:** Same habit as adding a project. Known repos are one click; a never-seen folder still works.
- **Rejected:** OS folder dialog only. Recent projects only.

## Decision: transcript after a move

- **Chosen:** Persist a `desktop.cwdChanged` custom message: `old → new`.
- **Why:** Later reads need to see when the chat jumped folders.
- **Rejected:** Toast only. Silent remount.

## Still open

- Cockpit / embedded Pi TUI restart after relocate (Desktop chat remounts; TUI is keyed by session id).
