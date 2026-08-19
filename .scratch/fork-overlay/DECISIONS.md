# Fork overlay decisions

Daily GUI is DLYZZT, forked at `Doeye1997/pi-agent-desktop` (`F:\Project\dlyzzt-pi-desktop`). Extras must survive `rebase upstream`.

## Overlay

- **Decision:** Where do fork extras live?
- **Chosen:** Overlay. Renderer `src/renderer/fork/`, host `src/agent-host/fork/`, main `src/main/fork/`. Upstream files only call hooks.
- **Why:** Rebase conflicts stay on hook lines.
- **Rejected:** Patch upstream files and hand-fix every rebase. Cherry-pick official commits and skip the rest.

## Take official updates

- **Decision:** How to take DLYZZT updates?
- **Chosen:** `git rebase upstream/main`.
- **Why:** Linear history. Abort if it goes wrong.
- **Rejected:** Merge (messier). Ignore official updates.

## Session list

- **Decision:** What does the left list show?
- **Chosen:** All projects mixed by default. Project picker is a filter. New session still uses last `selectedCwd`.
- **Why:** Switching repos just to _see_ sessions was the pain.
- **Rejected:** Keep hard per-repo list. Add only an "All" opt-in.

## Archive

- **Decision:** How to hide old sessions?
- **Chosen:** Manual archive / unarchive. File stays. Flag is `desktop.archived` custom entry in the session jsonl (follows `F:\PiData`).
- **Why:** Recoverable. Travels with the session.
- **Rejected:** Auto-archive by age. Skip archive.

## Archive vs fork tree

- **Decision:** Archive a parent/child?
- **Chosen:** Only that row. Children stay (may become roots).
- **Why:** Less collateral hide.
- **Rejected:** Archive whole tree. Block archive while children exist.

## Project folders

- **Decision:** How to tell projects apart in the all-projects list?
- **Chosen:** Group by project folder. Folders collapse. Header `+` opens a new session in that folder's cwd. Folder-icon toggle switches back to the date-grouped flat list. Remembered in localStorage.
- **Why:** See every repo without mixing rows. New session no longer depends on last click.
- **Rejected:** Tags only. Bottom project-picker drawer.

## Official auto-update

- **Decision:** Can DLYZZT's updater replace this install?
- **Chosen:** No. `forkAllowOfficialUpdater()` is false. Installed `app-update.yml` points at `Doeye1997/pi-agent-desktop` (no releases). `ui-state.automaticUpdateChecks` is false.
- **Why:** Official 0.1.9+ installer would wipe overlay.
- **Rejected:** Keep official auto-update. Publish our own GitHub releases for now.

## Official 0.1.9 code

- **Decision:** Take the 0.1.9 _code_?
- **Chosen:** Yes, via rebase (scroll-to-bottom badge + magnet fixes). Do not run the official installer.
- **Why:** Want the feature, not their packaged overwrite.

## Daily launch

- **Decision:** How does the daily GUI start?
- **Chosen:** Raycast still opens `F:\App\...\Pi Agent Desktop.exe`. That file is a 4KB stub → `launch-pi-agent-desktop.cmd` → `npm run dev`. Real Electron is `Pi Agent Desktop.packaged.exe`.
- **Why:** asar pack is slow. Renderer HMR. Stop/Escape and host changes just restart the black window.
- **Rejected:** Keep packaged exe as daily. Exe that watches repo `out/` (fragile). Build-without-asar copy into the install.

## Dev console

- **Decision:** Show the npm/Vite terminal?
- **Chosen:** Yes. Closing the window quits the app.
- **Why:** See compile errors. Same as `launch-dlyzzt-dev.cmd`.
- **Rejected:** Hidden console (looks like exe; hangs go to Task Manager).

## Packaged exe

- **Decision:** Keep `F:\App\Pi Agent Desktop`?
- **Chosen:** Fallback only. `F:\PiData\launch-pi-agent-desktop-packaged.cmd` → `Pi Agent Desktop.packaged.exe`. Daily `Pi Agent Desktop.exe` is a stub that starts `npm run dev`. Do not run both (same userData).
- **Why:** Offline / Vite-broken escape hatch. Not the daily path.
- **Rejected:** Delete the install. Keep asar refresh as the default ship path.

## Stop / abort vs hung bash

- **Decision:** What should Desktop Stop do when bash/HTTP will not die?
- **Chosen:** CLI-shaped abort. `agent.command` `abort` fires `abortBash` + `agent.abort()`, then **returns**. `session.abort()` / `waitForIdle` runs in the background (`void`). Next user prompt is a new `turnSeq` and is **not** skipped by `pendingAbort` (latch only applies to `turnSeq <= abortedTurnSeq`). Renderer Stop is optimistic (hide running UI, ignore `agent_start` / tool events while `abortRequestedRef`). Do **not** poll `agent.state` after Stop — that RPC can sit 120s and freeze send.
- **Why:** Grok CLI / Codex CLI / Pi TUI Escape send the abort signal and keep the UI live. Old Desktop `await session.abort()` waited for idle on the shared Host. Hung MSYS `unzip` / SFTP → abort RPC timeout → later Stop/send queued → whole app looked dead. Same kill tree as CLI; the Desktop-only bug was waiting on it inside RPC.
- **Rejected:** Await `waitForIdle` on the abort RPC. Skip the next prompt whenever `pendingAbort` is set. After Stop, loop `agentState` until idle before allowing send.
- **Ops:** Host is not Vite HMR. After this change, close the black window / restart `npm run dev`. Do not run packaged exe and dev together (same `F:\PiData\desktop`). Prefer a new session over sending on a still-red Stop turn — Enter while Stop is visible **queues**, it does not start a new turn.
- **Kill:** Desktop bash no longer uses upstream fire-and-forget `taskkill`. `execDesktopBash` waits on `terminateProcessTree` (soft `/T`, then `/F`) so Stop can end paramiko/unzip children and the agent loop can leave the tool.
