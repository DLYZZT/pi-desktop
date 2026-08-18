import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./EmbeddedPiTerminal.tsx", import.meta.url), "utf8");

test("embedded terminal keeps one xterm instance per selected Pi session", () => {
  assert.match(source, /new Map<string, TerminalEntry>/);
  assert.match(source, /terminals\.current\.get\(session\.id\)/);
  assert.match(source, /terminals\.current\.set\(session\.id/);
  assert.match(source, /terminalEntry\.element\.hidden = sessionId !== session\.id/);
});

test("embedded terminal remounts when the same session moves to a new cwd", () => {
  assert.match(source, /entry\.cwd !== session\.cwd/);
  assert.match(source, /disposeTerminalEntry\(entry\)/);
  assert.match(source, /cwd: session\.cwd/);
});

test("embedded terminal connects xterm input, output and fit dimensions to the PTY bridge", () => {
  assert.match(source, /onSessionTuiData/);
  assert.match(source, /writeSessionTui/);
  assert.match(source, /resizeSessionTui/);
  assert.match(source, /new FitAddon\(\)/);
  assert.match(source, /new ResizeObserver/);
});

test("embedded terminal pins Windows IME to the Pi editor caret, not the ConPTY EOL cursor", () => {
  assert.match(source, /applyImeOverlay/);
  assert.match(source, /findImeAnchorCell/);
  assert.match(source, /isInverse\(\)/);
  assert.match(source, /lineLooksLikeBorder/);
  assert.match(source, /ch === "-"/);
  assert.match(source, /hardwareX < cols \/ 2/);
  assert.match(source, /rows - 3/);
  assert.match(source, /lockedImeAnchor/);
  assert.match(source, /if \(!locked\)/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /compositionView\.style\.left !== left/);
  assert.match(source, /addEventListener\("compositionstart", startImeComposition, true\)/);
});

test("embedded terminal copies selected text without swallowing Ctrl+C interrupts", () => {
  assert.match(source, /attachCustomKeyEventHandler/);
  assert.match(source, /terminal\.hasSelection\(\)/);
  assert.match(source, /copyText\(terminal\.getSelection\(\)\)/);
  assert.match(source, /return false/);
  assert.match(source, /return true/);
});

test("embedded terminal lets the native paste event handle Ctrl+V", () => {
  assert.match(source, /const isPaste = event\.type === "keydown"/);
  assert.match(source, /event\.key\.toLowerCase\(\) === "v"/);
  assert.match(source, /if \(isPaste\) return false/);
});

test("embedded terminal opens detected web links only on Ctrl+click", () => {
  assert.match(source, /new WebLinksAddon/);
  assert.match(source, /event\.ctrlKey/);
  assert.match(source, /window\.piBridge\.openExternal\(url\)/);
});

test("embedded terminal packages the TUI dock as a Fluent GUI composer", () => {
  assert.match(source, /TuiDockComposer/);
  assert.match(source, /worktreeAnchorRef/);
  assert.match(source, /parseDockChrome/);
  assert.match(source, /readLiveScreenLines/);
  assert.match(source, /buffer\.baseY/);
  assert.match(source, /terminalPane/);
  assert.match(source, /onSessionRelocated/);
  assert.match(source, /scheduleDockChrome/);
  assert.match(source, /COVER_MIN_ROWS/);
  assert.match(source, /applySessionLayout/);
  assert.match(source, /applySessionLayout/);
  assert.match(source, /coverOn/);
  assert.match(source, /onHideCover/);
  assert.doesNotMatch(source, /minHeight: dockClipPx/);
  assert.match(source, /scheduleDockChromeRef/);
  assert.doesNotMatch(source, /measureDockCoverPx/);
  assert.doesNotMatch(source, /dockRect/);
  assert.match(source, /addEventListener\("wheel"/);
  assert.match(source, /\\x1b\[<\$\{button\};\$\{col\};\$\{row\}M/);
  assert.match(source, /onSelectModel/);
  assert.match(source, /onSelectThinking/);
  assert.match(source, /\/model \$\{provider\}\/\$\{id\}/);
  assert.match(source, /writeSessionTui\(session\.id, text \+ "\\r"\)/);
});
