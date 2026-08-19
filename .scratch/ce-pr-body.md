## Summary

Pi now stays in one Electron window instead of two floating cockpit panes plus an external Windows Terminal. Chinese IME candidates sit on the editor caret instead of the footer’s far right. Changing a session folder moves that session’s file and keeps the same id.

The embedded xterm used to follow ConPTY’s leftover cursor at the end of the status line, so unconfirmed pinyin opened over the model name. The helper textarea is now pinned to the visible editor cell and locked for the duration of a composition so the candidate window does not bounce on each key.

A session can change its working directory without starting over. The jsonl file is moved with the new cwd and the sidebar refreshes in place.

## Validation

`node --test` on the cockpit PTY, IME contract, relocate, and handler surfaces: 37 passed.

Manual: after a full renderer reload, Microsoft Pinyin candidates appeared on the input row (was footer-right). The later “lock left/top while composing” change was not re-probed on the live IME.
