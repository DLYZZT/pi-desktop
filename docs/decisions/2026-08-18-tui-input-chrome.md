# TUI input chrome — 2026-08-18

Decisions from the cockpit input-wrap grill. Not a spec.

## Decision: wrap target

- **Chosen:** Mature GUI composer over the TUI dock, matching the two-capsule screenshot: chip bar (folder / Local / worktree) + real text field. Opaque. Covers the character editor.
- **Why:** User: not a transparent frame around TUI glyphs. Package it as GUI, including WORKTREE.
- **Rejected:** Outline Card around live TUI cells. Editor box only.

## Decision: input ownership

- **Chosen:** Type in the Fluent textarea. Enter writes the finished line to the Pi PTY. TUI editor stays covered.
- **Why:** Screenshot is a real input, not a frame. PTY still owns the session.
- **Rejected:** Visual chrome only. Bring back in-process ChatInput. Per-keystroke forwarding.

## Decision: first UI-library shortlist

- **Chosen:** None. User rejected the whole shortlist. Find another set.
- **Why:** User: "这几个我都不喜欢，请记录."
- **Rejected:**
  - No new library (reuse `chat-composer-shell` + CSS tokens)
  - shadcn/ui Card
  - daisyUI `card`
- **Open:** Dislike reason not given. Next shortlist must not repeat those three.

## Decision: UI library

- **Chosen:** Fluent UI React v9 (`@fluentui/react-components`).
- **Why:** User picked 3 from the second shortlist. Desktop-app Card, not Tailwind/shadcn/daisy.
- **Rejected:** Mantine. Radix Themes. Earlier shortlist (no library, shadcn/ui, daisyUI).

## Decision: no overlay

- **Chosen:** Clip a fixed 6 TUI rows. HTML card overlays that same 6-row band. Terminal pane stays full size — card does not push the TUI up.
- **Why:** Dock height is basically stable. Scanning characters and chasing height caused jump/flash.
- **Rejected:** Absolute overlay. Per-frame character-scan clip. Resize PTY to chase card height.

## Decision: what the sheet covers

- **Chosen:** Cover the TUI editor rules + path + usage/model footer + MCP/SuperGrok. Leave `⠴ Working` visible above the sheet.
- **Why:** User pasted those exact lines as the cover target, then said do not cover Working.
- **Rejected:** Cover last N rows. Overlay the whole bottom 10 rows.

## Decision: sheet layout

- **Chosen:** Input fills top/left/right of the sheet. Under it: cwd picker, worktree, usage, model, thinking, MCP/SuperGrok.
- **Why:** User: 内容框要占满左右和上方，其他按钮放下方. Current 3-row chip stack is too rough; next change waits on the mock.
- **Rejected:** Chips above the input. Screenshot Local / Do anything.

## Decision: cwd in the composer

- **Chosen:** Working directory is a control on the bottom bar, not a dead label. Reuse 更换工作目录: recent projects + browse folder.
- **Why:** User: 工作目录也要可以在这选择.
- **Rejected:** Path as text only. Invent a second cwd picker.

## Decision: composer content

- **Chosen:** Show this product's dock facts as chips: path, worktree, usage, model, thinking, PR/MCP/SuperGrok. Screenshot was layout only.
- **Why:** User rejected cloned ChatGPT chips (Local, Do anything) and missing usage/model/thinking.
- **Rejected:** Local badge. Screenshot placeholder copy. Folder-name-only chip.

## Decision: Fluent theme

- **Chosen:** Fluent default light/dark (`webLightTheme` / `webDarkTheme`), switched with the app theme.
- **Why:** User picked 2. Wants the stock Fluent look, not a remapped warm-paper skin.
- **Rejected:** Map Fluent tokens onto `--bg` / `--accent`. Fluent Dark only.
