# Desktop custom text panels (experimental profile v1)

Desktop keeps extension components in the Agent Host. Only bounded ANSI text frames and input messages cross into the renderer; extension JavaScript never executes there.

An extension can query `ctx.ui.getDesktopUiCapabilities?.()` structurally. This is a Desktop-local extension, not an upstream Pi SDK API. `ctx.mode` remains `rpc`. The profile is unavailable during external messaging-channel turns and after session disposal. Ordinary RPC hosts must not be assumed interactive.

Version 1 provides a virtual viewport, a limited theme facade, coalesced rendering, keyboard input, bracketed paste and explicit close. It does not implement a terminal emulator. `keybindings: false` means the factory's keybindings argument is undefined. `nestedOverlays: false` excludes nested overlays. No raw terminal write/lifecycle API is provided. `mouseWheel: "sgr"` describes wheel sequences forwarded when the panel has no native overflow; native overflow scrolling takes precedence. Extensions must opt into this limited profile knowingly rather than equating `customTui` with full TUI parity.

Only one panel is active per host session; replacement closes its predecessor. Explicit Close, reload and destruction dispose it. View changes alone do not cancel it: existing pending-request replay restores it when returning. Input from a retired renderer owner is ignored.

Shift+Tab reaches the native Close button; Tab returns to input. Ctrl/Cmd+Escape explicitly closes even if the component ignores Escape. During IME composition the native input is visible; only committed text is delivered to the component. Paste is bounded to 100,000 UTF-16 code units and strips terminal controls.

`atomicEditorInsert: true` enables `insertEditorTextIfEmpty(text)`, returning `inserted`, `not_empty`, or `unavailable`. The live renderer refuses nonempty text, attachments and active composition. Successful insertion does not submit or steal modal focus. Requests expire after two seconds and are never replayed. `unavailable` means acknowledgement was not confirmed; consumers should ask users to inspect the draft before retrying, not claim no insertion occurred. Consumers must not use cached editor text for this decision.

The ANSI compatibility surface deliberately uses a stable dark canvas inside either light or dark application chrome. Pi Markdown uses the built-in dark SDK theme once per host lifetime; session terminal preferences cannot overwrite it. This is not live terminal-theme synchronization. Real-component and physical input-method acceptance remain important alongside unit tests. This document describes an experimental candidate, not a full extension-compatibility guarantee.

## Reproduce without Bro or a model

Run `npm ci`, `npm run build`, then `node scripts/custom-ui-smoke.mjs` from this checkout. The launcher creates a fresh temporary agent and Electron profile and prints its path; it does not load your normal agent settings. Open a session and run `/desktop-ui-smoke`. Type and paste Unicode, resize, scroll, then press Esc: the input/viewport should update and the timer should stop on disposal. Remove the printed temporary profile after closing the app if no longer needed. This is manual acceptance tooling, not an automated cross-platform Electron test.

Suggested review order: shared capability/types; host bridge and lifecycle tests; renderer input and panel; atomic insertion ownership/tests; argument completions; ANSI normalization.
