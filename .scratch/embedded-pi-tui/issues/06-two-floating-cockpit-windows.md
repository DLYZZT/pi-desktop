# 06 — Two floating cockpit windows; middle is not the live path

**What to build:** Desktop chrome becomes two always-on-top windows: the session tree on the left, files and the user-driven browser on the right. There is no middle chat as a live runtime. The composer does not send in-process prompts. Conversation history is only in the `pi` TUI. Channel inbound does not enter these sessions.

**Blocked by:** 03 — Tree marks + kill / exit / reselect

**Status:** ready-for-agent

- [ ] Session tree and files/browser are two independent always-on-top windows, not docked to the terminal
- [ ] There is no middle chat pane acting as the live agent
- [ ] Desktop does not issue in-process prompts, steers, follow-ups, or aborts on this path
- [ ] No Desktop transcript / history viewer is added
- [ ] Channel inbound does not open or prompt these sessions; settings make that drop visible
- [ ] Agent browser tools stay unused; the user can still drive the browser dock
