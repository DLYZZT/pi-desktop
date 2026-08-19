# Cockpit + external Pi TUI

Status: ready-for-agent

## Problem Statement

The Desktop shell does not show the real CLI. It runs `pi-coding-agent` in-process and paints its own turn state. That state lies: a pulsing "Waiting for model…", tool cards that stay `running` until a result exists, and Stop that makes the composer look idle while the host turn is still stuck. Switching away and back shows the session still captured. The user cannot see what the CLI is actually doing, and cannot trust the shell enough to keep talking.

## Solution

Desktop becomes two always-on-top cockpit windows. There is no middle chat pane.

- Left: session tree. Each row is a tab.
- Right: files and the user-driven browser for the selected session's cwd.
- Live agent: an external Windows Terminal (or equivalent) running the Desktop-bundled `pi --session <id>`.

Selecting a session starts that `pi` if it is not running, or focuses its existing terminal if it is. Switching tabs leaves other `pi` processes running. History is whatever the TUI already shows. Archive only hides a row from the default list; opening an archived session is the same `pi --session` path.

Desktop does not prompt in-process. Channel inbound and agent-driven browser control are dropped for this cut. Closing Desktop kills every spawned `pi`.

## User Stories

1. As a Desktop user, I want the live agent to be a real `pi` TUI in an external terminal, so that I see the same running state I would see in a normal CLI.
2. As a Desktop user, I want that TUI to be the bundled Desktop `pi`, so that keybindings and session files match the app I already run.
3. As a Desktop user, I want `pi` to open the same session id the left-tree row represents, so that the tab and the terminal are one conversation.
4. As a Desktop user, I want no middle chat pane, so that Desktop stops pretending to be a second runtime.
5. As a Desktop user, I want the session tree in a floating always-on-top window, so that I can switch conversations while looking at the terminal.
6. As a Desktop user, I want files and the user-driven browser in a second floating always-on-top window, so that the project stays beside the TUI.
7. As a Desktop user, I want the left tree to act as tabs, so that selecting a row switches the active session.
8. As a Desktop user, I want selecting a session with no live `pi` to start `pi --session` in a new terminal, so that talking does not take an extra open step.
9. As a Desktop user, I want selecting a session whose `pi` is already live to focus that terminal, so that I return to the same TUI.
10. As a Desktop user, I want selecting the already-selected live tab to only focus its terminal, so that a second click does not restart `pi`.
11. As a Desktop user, I want switching tabs to leave the previous `pi` running, so that a long turn does not die when I glance at another chat.
12. As a Desktop user, I want several sessions to hold background terminals at once, so that parallel work survives tab switches.
13. As a Desktop user, I want the left tree to mark a live TUI as running, waiting for input, or dead, so that background sessions are not a black box.
14. As a Desktop user, I want a session with no process to show no live mark, so that idle rows stay quiet.
15. As a Desktop user, I want conversation history to live in the `pi` TUI, so that Desktop does not draw a second transcript.
16. As a Desktop user, I want an archived session to start or focus `pi --session` the same way, so that I can read old chats in the TUI.
17. As a Desktop user, I want archive to only hide the row from the default list, so that archive is not a different viewer.
18. As a Desktop user, I want unarchive to put the row back in the default list without spawning, so that restore does not surprise-open a terminal.
19. As a Desktop user, I want `/exit` inside the TUI to stop that process, so that I can leave the same way I leave a terminal.
20. As a Desktop user, I want a left-tree kill on a live row, so that I can stop a background `pi` without focusing it first.
21. As a Desktop user, I want a killed or exited tab not to auto-restart while it stays selected, so that kill cannot flap the process back up.
22. As a Desktop user, I want selecting that tab again after a stop to start a new `pi`, so that I can continue when I choose.
23. As a Desktop user, I want closing Desktop to kill every spawned `pi`, so that no orphan terminals remain.
24. As a Desktop user, I want a relaunch to start cold, so that I am not hunting leftover terminals from last time.
25. As a Desktop user, I want the Desktop composer gone on this path, so that two agents cannot fight one session file.
26. As a Desktop user, I want a folder `+` new session to create a session and start `pi` in that folder's cwd, so that new work still starts from the tree.
27. As a Desktop user, I want the right window to follow the selected session cwd, so that files and the browser match the tab I just chose.
28. As a Desktop user, I want to drive the built-in browser myself, so that I can still open pages beside the TUI.
29. As a Desktop user, I want the agent not to control that browser in this cut, so that we do not build a CLI-to-shell tool bridge.
30. As a Desktop user, I want Feishu / Telegram / Weixin inbound not to enter these sessions, so that a second host agent cannot prompt the same file.
31. As a Desktop user, I want channel settings to remain visible as disabled-for-this-cut, so that I know IM inbound was dropped on purpose.
32. As a Desktop user, I want a crashed `pi` to show dead in the tree, so that a silent exit is not painted as running.
33. As a Desktop user, I want PATH `pi` to be ignored, so that a different installed CLI cannot open the session with another version.
34. As a Desktop user, I want session jsonl writes from the TUI to update the tree title/mtime, so that the tab list still tracks reality.
35. As a Desktop user, I want overlay extras (archive, all-projects grouping, official-updater off) to survive, so that this is still the fork cockpit.
36. As a Desktop user, I want all-projects folders and filters to keep working in the left window, so that I can still find every repo's chats.
37. As a future agent, I want in-process `agent.command` prompt/abort left unused on this path, so that the old Stop-lie path is not the live run path.
38. As a future agent, I want one lifecycle table to decide spawn, focus, keep, and kill, so that the chrome cannot invent a second running flag.

## Implementation Decisions

- Overlay owns the cockpit extras. The old middle chat runtime is not the live path.
- Desktop chrome is two independent always-on-top windows: session tree, and files/browser. They are not docked to the terminal HWND.
- Live run is an external terminal process, not an embedded PTY and not an in-process agent prompt.
- One application module owns session TUI lifecycle. Inputs: select session (id, archived, cwd), tree kill, archive/unarchive, app quit, child exit. Outputs: per-session process record (`none` | `starting` | `running` | `waiting_input` | `dead`) and the next action (`spawn` | `focus` | `keep` | `kill` | `noop`).
- Infrastructure is a process port: start bundled `pi --session <id>` in the session cwd via the platform terminal, focus an existing window, kill the process tree, report exit. Tests fake this port. No second policy module.
- Select with no live process, and this select is a new select (not the already-selected live tab) → spawn. Already-selected live tab → focus only.
- Select a live other session → focus that terminal; previous process stays.
- Archive / unarchive change list membership only. They do not kill or spawn. Opening an archived row uses the same select rule.
- `/exit`, crash, or tree kill → that process record becomes `dead`. No auto-spawn while it remains the current selection. A later select of a `dead` or missing process → spawn again.
- App quit / window close → kill every tracked `pi` tree. Next launch has an empty process map.
- Spawn uses the Desktop-bundled CLI, never PATH. Same coding-agent version the app already ships.
- Desktop must not issue in-process prompts, steers, follow-ups, or aborts on this path. Host may still serve session index, files, and the user-driven browser.
- Channel inbound must not open or prompt these sessions. Do not build a TUI bridge.
- Agent browser tools stay unused. The right-window browser dock can still be opened by the user.
- Left-tree status is a projection of the process map. Do not parse TUI bytes. Do not poll in-process `agent.state` for this mark. Waiting-for-input is optional when the port can say so cheaply; otherwise live means running.
- Do not build a Desktop transcript viewer, history tab, or frozen terminal screenshot for this cut.
- Do not embed xterm.js / node-pty.
- Old in-process running-session events are not the tree source for these sessions.
- Kill uses the existing process-tree terminator on that child, not `agent.command` abort.

## Testing Decisions

- Good tests only check external lifecycle behavior: given select / archive / unarchive / kill / exit / quit, did the runtime spawn, focus, keep, kill, or refuse. They do not launch Windows Terminal, boot Electron, or assert window chrome.
- One seam: the session TUI runtime, with a fake process port. Tree marks and "which window to focus" are projections of its output. Do not add a second policy seam.
- Do not add a live `pi` e2e or a visual terminal test. Those do not change the next action once the lifecycle table is right.
- Prior art: overlay contract tests beside the module (`node:test` + `assert`), same style as the session-list overlay tests. Fake the process port the way those tests fake session rows.

## Out of Scope

- Embedding a terminal in Electron (xterm.js, node-pty, ConPTY glue).
- Docking cockpit windows to the terminal HWND.
- A Desktop transcript / history viewer.
- Bridging the TUI back to Desktop browser tools or channel inbound.
- Running a second in-process agent for IM or browser beside the TUI.
- Using PATH `pi`, detaching `pi` after Desktop quits, or asking on quit.
- Keeping the Desktop composer as a second live input.
- Changing official auto-update, archive storage (`desktop.archived`), or the all-projects list rules, except that archive no longer means "do not start `pi`".
- Fixing in-process Stop/hang on the old prompt path, except by no longer using that path.
- Subagent tool-card live trails on Desktop chat cards.

## Further Notes

Earlier embed-in-the-middle and "archived is read-only history" decisions are superseded. The TUI is the runtime and the history surface. Desktop is only tabs + files + a user browser.

The in-process host stays as cockpit infrastructure. It is not the live agent.

Seam check: if this should instead be tested through a larger window-manager façade, say so before implementation. The spec assumes one lifecycle table plus a fake process port is enough.
